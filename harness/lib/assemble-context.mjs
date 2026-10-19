/**
 * The suggestion prompt's context, assembled from a project's adapter in one
 * place. run-generation.mjs used to build it inline, which left the probe
 * (that drops a model whose window is too small) and the replay bench with no
 * way to see the prompt they were reasoning about. Now all three call this.
 *
 * Also the provenance a record needs for a run to be replayed or compared
 * later: which commit, which adapter and briefs, how big each block was, and
 * a hash of the exact prompt. Without these, "variant B used fewer tokens"
 * cannot be told apart from "variant B ran on a smaller repository".
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { constitutionAllowlist, guardConfig, memoryConfig, contextConfig } from './adapter.mjs';
import { compileAllowlist, expandEditablePaths } from './edit-format.mjs';
import { globToRegExp } from './glob.mjs';
import {
  buildSourceBundle, buildRepoManifest, buildTestIndex, buildArchitectureNotes,
  buildGenerationIndex, buildGenerationHistory, buildRuntimeEvidence, fenceUntrusted,
  estimateContextSize,
} from './context-pack.mjs';
import { loadLatestThemesReview, buildThemesBrief, buildOpenQuestionsBrief } from './themes.mjs';
import { buildMetricsBrief, loadLatestMetrics } from './evaluators.mjs';
import { buildEscalationBrief, loadLedger } from './escalations.mjs';
import { buildImportGraph, renderCodeMap, DEFAULT_MAP_MAX_CHARS } from './code-map.mjs';
import { loadLessons, buildLessonsBrief, diskLookups } from './lessons.mjs';

export const sha256 = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex');

/**
 * @param {{repoRoot: string, adapter: object}} opts
 * Under `context.strategy: scoped` the full source is NOT in the context:
 * `context.codeMap` is, and `scoped` carries what the suggest stage needs to
 * let each model choose files to read (orchestrator.mjs's suggest()).
 *
 * @returns {{context: object, editableFiles: string[], editablePaths: string[], createOnlyPaths: string[], allowlist: object, generationsDir: string, memory: object, ctxConfig: object, sourcesFor: (files: string[]) => string, graph: object, scoped: {maxSourceChars: number}|null}}
 */
export function assembleContext({ repoRoot, adapter }) {
  const { allowedPaths: editablePaths, createOnlyPaths } = constitutionAllowlist(adapter);
  const allowlist = compileAllowlist({ allowedPaths: editablePaths, createOnlyPaths });
  // The allowlist matches patterns; the prompt needs real files. Expand once,
  // here, so every downstream use (source bundle, snapshots, the record of
  // what was editable) sees the same concrete list the model was shown.
  const editableFiles = expandEditablePaths(editablePaths, { repoRoot });
  const guard = guardConfig(adapter);
  const memory = memoryConfig(adapter);
  const ctxConfig = contextConfig(adapter);
  const generationsDir = ctxConfig.generationsDir || 'docs/generations';
  const latestThemes = loadLatestThemesReview({ repoRoot, themesDir: memory.themesDir || 'docs/themes' });
  const sourcesFor = (files) => fenceUntrusted('SOURCE', buildSourceBundle(files, { repoRoot })) ?? '';
  const scoped = ctxConfig.strategy === 'scoped' ? { maxSourceChars: ctxConfig.scopedMaxSourceChars } : null;
  // Built for every strategy: the reviewer's dependents and a lesson's
  // neighbours come from the same graph. Only 'scoped' puts it in the prompt.
  const graph = buildImportGraph(editableFiles, { repoRoot });

  const context = {
    // Fenced (context-pack.mjs's fenceUntrusted()): the source and the
    // architecture notes are the two blocks a stranger with commit access to
    // the project could have written into.
    sources: scoped ? null : sourcesFor(editableFiles),
    // File names, sizes, symbols and imports — what a scoped suggester reads
    // to choose its files. Fenced: symbol names come from the repository.
    codeMap: scoped ? fenceUntrusted('CODE MAP', renderCodeMap(graph, { maxChars: ctxConfig.mapMaxChars ?? DEFAULT_MAP_MAX_CHARS })) : null,
    manifest: buildRepoManifest({
      repoRoot,
      purposes: ctxConfig.purposes,
      allowlist,
      appendOnlyPaths: guard.appendOnlyPaths.map(globToRegExp),
      createOnlyDescription: createOnlyPaths.length ? createOnlyPaths.join(', ') : undefined,
    }),
    testIndex: buildTestIndex({ repoRoot, testFiles: ctxConfig.testFiles }),
    // The records quote model output, reviewers' reasons and test output —
    // all of it text that repository content can steer. Fenced like the
    // source, so an injection that reached one run's record is not read as
    // an instruction by the next. The oldest generations are summarised as
    // counts past context.index_rows, so the index stops growing without
    // bound.
    generationIndex: fenceUntrusted('GENERATION RECORDS', buildGenerationIndex({ repoRoot, generationsDir, maxRows: ctxConfig.indexRows })),
    // context.history_limit was read by the adapter and then ignored here:
    // every run used 3.
    history: fenceUntrusted('RECENT GENERATIONS', buildGenerationHistory({ repoRoot, generationsDir, limit: ctxConfig.historyLimit ?? 3 })),
    architectureNotes: fenceUntrusted('ARCHITECTURE NOTES', buildArchitectureNotes({ repoRoot, docPath: ctxConfig.architectureNotesPath, appendOnlyMarker: ctxConfig.architectureNotesMarker })),
    themes: buildThemesBrief(latestThemes),
    // The UNKNOWN field of the same review — docs/curiosity/C2, phase A.
    openQuestions: buildOpenQuestionsBrief(latestThemes),
    escalations: buildEscalationBrief(
      loadLedger({ repoRoot, ledgerPath: memory.ledgerPath || undefined }),
      { threshold: { models: memory.consensus.models ?? 3, labs: memory.consensus.labs ?? 2 } }
    ),
    platform: ctxConfig.platformNotes,
    feedback: null, // player-feedback equivalent: not ported (project-specific)
    // Whatever this project's evaluator plugins measured after the LAST
    // generation. Null with no evaluators, which drops the section.
    qualityMetrics: buildMetricsBrief(loadLatestMetrics({ repoRoot, generationsDir })),
    // What the last few runs actually SAW — not a verdict and not a score.
    runtime: fenceUntrusted('RUNTIME OBSERVATIONS', buildRuntimeEvidence({ repoRoot, evidenceDir: ctxConfig.runtimeEvidenceDir || undefined })),
    // Lessons anchored to the files they concern, stale ones left out
    // (lessons.mjs). Null until a record yields one.
    lessons: buildLessonsBrief(loadLessons({ repoRoot, generationsDir }), { hashOf: diskLookups(repoRoot).hashOf }),
  };

  return { context, editableFiles, editablePaths, createOnlyPaths, allowlist, generationsDir, memory, ctxConfig, guard, sourcesFor, graph, scoped };
}

/**
 * Per-block sizes and a token estimate for the suggestion prompt: every
 * context block, plus the brief (the system prompt) and the images.
 */
export function measureContext({ context, agentBrief = '', imageCount = 0, scoped = null }) {
  const blocks = { brief: agentBrief };
  for (const [name, text] of Object.entries(context ?? {})) {
    if (typeof text === 'string') blocks[name] = text;
  }
  const size = estimateContextSize({ blocks, imageCount });
  // Scoped runs read up to this much source on their second call; count the
  // ceiling, since a window has to hold the worst case.
  if (scoped?.maxSourceChars) {
    size.scopedSourceCeilingChars = scoped.maxSourceChars;
    size.textChars += scoped.maxSourceChars;
    size.estimatedTokens += Math.round(scoped.maxSourceChars / 4);
  }
  return size;
}

/** The commit the run started from, or null outside a git checkout. */
export function headCommit(git) {
  try { return git('rev-parse', 'HEAD') || null; } catch { return null; }
}

/** Hash of a file's bytes, or null when it is absent. */
export function fileHash(repoRoot, relative) {
  if (!relative) return null;
  try { return sha256(fs.readFileSync(path.resolve(repoRoot, relative))); } catch { return null; }
}
