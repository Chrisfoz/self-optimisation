import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import "../../harness/providers/index.mjs";
import { resolveProvider } from "../../harness/lib/llm-provider.mjs";
import {
  configure,
  modelCatalogue,
  LABS,
  harnessFiles,
  WORKFLOW,
  activationFiles,
  requiredSecretNames,
} from "../../console/configuration.mjs";
import { validateAdapter } from "../../harness/lib/validate.mjs";
export const valid = () => ({
  repository: "owner/project",
  defaultBranch: "main",
  labs: ["openai"],
  implementModel: "gpt-5",
  reviewModel: "claude-opus-5",
  rankModel: "gemini-3-pro",
  allowedPaths: ["src/app.js"],
  createOnlyPaths: ["tests/**"],
  frozenPaths: ["config/**"],
  testCommands: ["npm test"],
  goal: "Make this calculator easier to use.",
  constraints: "Preserve saved data and keyboard access.",
  hints: "Improve error feedback.",
  maxAttempts: 3,
  maxFanout: 2,
  maxGenerationTokens: 500000,
  cadence: "monthly",
  approvalClass: "human-approval-required",
  deploymentUrl: "",
});
test("all provider secret names come from the harness registry, including unwatched seats", () => {
  const g = configure(valid());
  assert.deepEqual(g.requiredSecrets, [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_API_KEY",
  ]);
  assert.equal(LABS.find((l) => l.name === "qwen").envKey, "QWEN_API_KEY");
  assert.equal(LABS.find((l) => l.name === "meta").envKey, "META_API_KEY");
  assert.deepEqual(
    requiredSecretNames({ labs: ["qwen"], reviewModel: "gpt-5" }),
    ["QWEN_API_KEY", "OPENAI_API_KEY"],
  );
});
// The reason the lab is selectable at all: a model released after this
// harness was written may carry a name no provider pattern matches, and the
// point of pinning seats is to be able to use it the day it ships.
test("a seat can name a model whose lab no pattern recognises, and the run learns where to send it", () => {
  const input = {
    ...valid(),
    labs: ["openai"],
    implementModel: "atlas-1",
    implementProvider: "openai",
    reviewModel: "claude-opus-5",
    reviewProvider: "",
    rankModel: "",
  };
  const g = configure(input);
  const a = load(g.files["project-adapter.yml"]);
  assert.equal(a.roles.implement.model, "atlas-1");
  assert.equal(a.roles.implement.provider, "openai");
  // An ID whose own name routes it needs no provider line, and gets none.
  assert.equal(a.roles.review.model, "claude-opus-5");
  assert.equal(a.roles.review.provider, undefined);
  // The named lab's key still has to be a secret — the seat is going to call it.
  assert.deepEqual(g.requiredSecrets, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  assert.deepEqual(requiredSecretNames(input), ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
  // Implementer and reviewer are different labs here, so no shared-lab warning.
  assert.ok(!g.warnings.some((w) => w.includes("same lab")));
  // Validation has nothing to say about these seats: the named lab is real,
  // and no key is missing. (Its other findings are about files that only
  // exist once the setup pull request is merged.)
  const validated = validateAdapter(a, { env: { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x" } });
  assert.deepEqual(validated.errors.filter((e) => /^roles\.(implement|review|rank)\./.test(e)), []);
  assert.deepEqual(validated.warnings.filter((w) => w.includes("atlas-1") || w.includes("API_KEY")), []);
});
test("a named lab that this harness cannot call is refused, not written", () => {
  assert.throws(
    () => configure({ ...valid(), implementModel: "atlas-1", implementProvider: "acme" }),
    /Unknown lab/,
  );
});
test("the model catalogue merges the bundled list with a project's own snapshot", () => {
  const shipped = modelCatalogue();
  assert.ok(shipped.counts.bundled > 0);
  assert.equal(shipped.counts.repository, 0);
  // `needsLab` must agree with where the id actually routes — asserted as an
  // invariant rather than as a property of the bundled data. This used to
  // read "every bundled ID names its own lab today, so none of them needs a
  // provider line", which was true only of the 16 models seeded from recorded
  // runs. A catalogue refreshed against the live labs carries 260, including
  // the ids DashScope resells under another lab's name
  // (`deepseek-v4.1-flash`, `glm-5.3`), and those DO need the line. The old
  // assertion was describing the fixture, not the behaviour.
  for (const lab of shipped.labs) {
    for (const m of lab.models) {
      let routesTo = null;
      try { routesTo = resolveProvider(m.id); } catch { routesTo = null; }
      assert.equal(
        m.needsLab,
        routesTo !== lab.name,
        `${lab.name}/${m.id}: needsLab=${m.needsLab} but the id routes to ${routesTo ?? 'nowhere'}`,
      );
    }
  }

  const live = modelCatalogue({
    snapshot: { openai: ["gpt-6-astra", "atlas-1"] },
    snapshotReadAt: "2026-09-12T09:00:00.000Z",
  });
  const openai = live.labs.find((l) => l.name === "openai");
  const atlas = openai.models.find((m) => m.id === "atlas-1");
  assert.deepEqual(atlas.sources, ["repository"]);
  assert.equal(atlas.unseen, true);
  // The flag the picker uses to decide whether to fill in the lab beside it.
  assert.equal(atlas.needsLab, true);
  assert.equal(openai.models.find((m) => m.id === "gpt-6-astra").needsLab, false);
  assert.equal(openai.envKey, "OPENAI_API_KEY");
});
test("all ten steps map into the real adapter, workflow and briefs", () => {
  const g = configure(valid());
  const a = load(g.files["project-adapter.yml"]);
  const w = load(g.files[WORKFLOW]);
  assert.equal(a.project.repository, "https://github.com/owner/project");
  assert.equal(a.project.default_branch, "main");
  assert.deepEqual(a.providers.watched, ["openai"]);
  assert.equal(a.roles.review.model, "claude-opus-5");
  assert.equal(a.roles.rank.model, "gemini-3-pro");
  assert.equal(a.roles.refine.max_attempts, 3);
  assert.deepEqual(a.constitution.allowed_paths, ["src/app.js"]);
  assert.deepEqual(a.constitution.create_only_paths, ["tests/**"]);
  assert.deepEqual(a.constitution.append_only_paths, []);
  assert.equal(a.project.goal.statement, valid().goal);
  assert.equal(a.cadence.schedule_cron, "0 0 1 * *");
  assert.equal(a.cadence.scheduled, false);
  assert.equal(a.constitution.approval_class, "human-approval-required");
  assert.equal(a.budget.max_generation_tokens, 500000);
  assert.equal(a.providers.max_fanout, 2);
  assert.ok(w.on.workflow_dispatch);
  assert.equal(w.on.schedule, undefined);
  assert.ok(
    w.jobs["self-improve"].steps.some((s) =>
      s.name?.startsWith("Open a pull request"),
    ),
  );
  assert.match(g.files[".claude/agents/improve.md"], /Improve error feedback/);
  assert.match(g.files[".claude/agents/review.md"], /END OF REVIEW/);
});
test("automatic merge remains off for rehearsal and only activates with a verification URL", () => {
  const v = {
    ...valid(),
    approvalClass: "autonomous-merge",
    deploymentUrl: "https://example.com",
    cadence: "weekly",
  };
  assert.equal(
    load(configure(v).files["project-adapter.yml"]).constitution.approval_class,
    "human-approval-required",
  );
  const active = activationFiles(v);
  assert.equal(
    load(active["project-adapter.yml"]).constitution.approval_class,
    "autonomous-merge",
  );
  assert.equal(load(active[WORKFLOW]).on.schedule[0].cron, "0 0 * * 1");
  const manual = activationFiles({ ...valid(), cadence: "manual" });
  assert.equal(load(manual[WORKFLOW]).on.schedule, undefined);
});
for (const [label, patch, pattern] of [
  ["no labs", { labs: [] }, /at least one lab/],
  ["unknown lab", { labs: ["fake"] }, /Unknown lab/],
  ["missing model", { reviewModel: "" }, /reviewer/],
  ["unknown model with no lab named", { reviewModel: "mystery-model" }, /does not name a lab/],
  ["unknown lab named for a seat", { reviewModel: "mystery-model", reviewProvider: "not-a-lab" }, /Unknown lab/],
  ["missing tests", { testCommands: [] }, /test command/],
  [
    "expression injection",
    { testCommands: ["echo ${{ secrets.OPENAI_API_KEY }}"] },
    /expressions/,
  ],
  [
    "multiline command",
    { testCommands: ["npm test\necho nope"] },
    /single lines/,
  ],
  ["no scope", { allowedPaths: [], createOnlyPaths: [] }, /at least one/],
  ["path traversal", { allowedPaths: ["../outside"] }, /relative/],
  ["frozen edit", { allowedPaths: ["harness/lib/scaffold.mjs"] }, /protected/],
  ["broad edit", { allowedPaths: ["**"] }, /protected/],
  ["frozen create", { createOnlyPaths: [".github/**"] }, /protected/],
  ["goal empty", { goal: "" }, /project goal/],
  ["constraint empty", { constraints: "" }, /constraints/],
  ["invalid cadence", { cadence: "daily" }, /cadence/],
  ["invalid approval", { approvalClass: "yes" }, /approval/],
  [
    "auto without verification",
    { approvalClass: "autonomous-merge" },
    /verification URL/,
  ],
  ["negative budget", { maxGenerationTokens: -1 }, /Token budget/],
  ["bad fanout", { maxFanout: 20 }, /Fan-out/],
  ["fractional attempt", { maxAttempts: 1.5 }, /Attempts/],
  ["unknown key", { apiKey: "do-not-store" }, /unsupported field/],
  ["branch injection", { defaultBranch: "main\nenv: bad" }, /branch/],
])
  test(`rejects ${label}`, () =>
    assert.throws(() => configure({ ...valid(), ...patch }), pattern));
test("connected validation uses actual files and the server-resolved branch", () => {
  assert.throws(
    () => configure(valid(), { tree: [{ path: "other.js", type: "blob" }] }),
    /No files match/,
  );
  assert.throws(
    () =>
      configure(
        { ...valid(), allowedPaths: ["src/**"], frozenPaths: ["src/auth/**"] },
        { tree: [{ path: "src/auth/login.js", type: "blob" }] },
      ),
    /protected file/,
  );
  const g = configure(valid(), {
    tree: [{ path: "src/app.js", type: "blob" }],
    defaultBranch: "trunk",
  });
  assert.equal(
    load(g.files["project-adapter.yml"]).project.default_branch,
    "trunk",
  );
});
test("download is a complete installation and passes the harness structural validator", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-install-"));
  try {
    const g = configure(valid());
    const files = {
      ...harnessFiles(),
      ...g.files,
      "src/app.js": "export const ready = true;",
      "package.json": '{"scripts":{"test":"node --test"}}',
    };
    for (const [p, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), content);
    }
    const result = validateAdapter(load(g.files["project-adapter.yml"]), {
      repoRoot: dir,
      env: {},
    });
    assert.deepEqual(result.errors, []);
    assert.ok(files["harness/scripts/rehearse.mjs"]);
    assert.ok(files["harness/VERSION"]);
    assert.ok(files["harness/lib/scaffold.mjs"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("project dependencies install before the pinned harness dependency, on setup and activation", () => {
  for (const files of [
    configure({ ...valid(), setupCommands: ["npm ci --ignore-scripts"] }).files,
    activationFiles({ ...valid(), setupCommands: ["npm ci --ignore-scripts"] }),
  ]) {
    const steps = load(files[WORKFLOW]).jobs["self-improve"].steps;
    const project = steps.findIndex(
      (s) => s.name === "Install project dependencies",
    );
    const harness = steps.findIndex(
      (s) => s.name === "Install harness dependencies",
    );
    assert.ok(project >= 0 && project < harness);
    assert.match(steps[project].run, /npm ci/);
  }
});

test("download ignores local secrets, dependencies and symlinks inside the harness", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-bundle-"));
  try {
    fs.mkdirSync(path.join(dir, "harness/node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "harness/.env"), "PRIVATE=never-export");
    fs.writeFileSync(path.join(dir, "harness/.env.example"), "PRIVATE=");
    fs.writeFileSync(
      path.join(dir, "harness/node_modules/file.mjs"),
      "private",
    );
    fs.writeFileSync(path.join(dir, "harness/VERSION"), "1.0.0");
    fs.symlinkSync(
      path.join(dir, "harness/.env"),
      path.join(dir, "harness/linked.mjs"),
    );
    assert.deepEqual(Object.keys(harnessFiles(dir + path.sep)).sort(), [
      "harness/.env.example",
      "harness/VERSION",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
