/** The browser is a client of the harness generator, never a second generator. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import "../harness/providers/index.mjs";
import {
  registeredProviders,
  getProvider,
  resolveProvider,
} from "../harness/lib/llm-provider.mjs";
import {
  renderAdapterYaml,
  renderWorkflowTemplate,
  renderCallerWorkflow,
  renderReadme,
  requiredProviders,
  SHARED_HARNESS_REPOSITORY,
} from "../harness/lib/scaffold.mjs";
import { harnessVersion } from "../harness/lib/version.mjs";
import { globToRegExp } from "../harness/lib/glob.mjs";
import { buildCatalogue } from "../harness/lib/model-catalogue.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const template = fs.readFileSync(
  new URL("../harness/templates/workflow.yml.tmpl", import.meta.url),
  "utf8",
);
// Read once at boot, like the console's pages: a deploy's files never change
// under it, and a missing or corrupt catalogue should stop the service now
// rather than 500 on the first person who opens the model picker.
const BUNDLED_CATALOGUE = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL("../harness/data/model-catalogue.json", import.meta.url)),
    "utf8",
  ),
);

/**
 * The model pick-list: what this deploy shipped with, merged with the
 * connected repository's own `.agent/model-snapshot.json` when one was read.
 * The console holds no lab keys, so that snapshot — written by the project's
 * last run, with the project's keys — is the only live catalogue that can
 * reach this screen. See harness/lib/model-catalogue.mjs.
 */
export function modelCatalogue({ snapshot = null, snapshotReadAt = null } = {}) {
  const catalogue = buildCatalogue({
    bundled: BUNDLED_CATALOGUE,
    snapshot,
    snapshotReadAt,
    provider: getProvider,
  });
  return {
    ...catalogue,
    labs: catalogue.labs.map((lab) => ({
      ...lab,
      models: lab.models.map((model) => ({
        ...model,
        // Whether this ID has to carry its lab explicitly. An ID a provider
        // pattern already routes correctly needs no `provider:` line in the
        // generated adapter, and the console should not write one; an ID
        // that resolves nowhere — or, worse, resolves to a DIFFERENT lab
        // than the one listing it — is unusable without one.
        needsLab: (() => {
          try {
            return resolveProvider(model.id) !== lab.name;
          } catch {
            return true;
          }
        })(),
      })),
    })),
  };
}

export const LABS = registeredProviders().map((name) => ({
  name,
  envKey: getProvider(name).envKey,
}));
export const PROTECTED = [
  "harness/**",
  ".github/**",
  ".claude/**",
  "project-adapter.yml",
  "package.json",
  "package-lock.json",
  ".env",
  ".env.*",
  ".git/**",
];
export const WORKFLOW = ".github/workflows/self-improve.yml";
const fail = (message) => {
  const error = new Error(message);
  error.status = 422;
  throw error;
};
const list = (v, name) => {
  if (
    !Array.isArray(v) ||
    v.length > 200 ||
    v.some((x) => typeof x !== "string" || !x.trim() || x.length > 1000)
  )
    fail(`${name} must be a list of non-empty values.`);
  return [...new Set(v.map((x) => x.trim()))];
};
const pathList = (v, name) =>
  list(v || [], name).map((p) => {
    if (
      !/^[A-Za-z0-9_.*/-]+$/.test(p) ||
      p.startsWith("/") ||
      p.split("/").some((x) => x === ".." || x === ".")
    )
      fail(
        `${name}: use relative repository paths without spaces or parent traversal.`,
      );
    return p;
  });
const integer = (v, min, max, name) => {
  if (!Number.isInteger(v) || v < min || v > max)
    fail(`${name} must be between ${min} and ${max}.`);
  return v;
};
const prose = (v, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > 16000)
    fail(`Enter ${name} (up to 16,000 characters).`);
  return v.trim();
};
export function configure(input, { tree = null, defaultBranch = null, shared = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("Configuration must be an object.");
  const keys = new Set([
    "repository",
    "defaultBranch",
    "labs",
    "implementModel",
    "reviewModel",
    "rankModel",
    "implementProvider",
    "reviewProvider",
    "rankProvider",
    "allowedPaths",
    "createOnlyPaths",
    "frozenPaths",
    "testCommands",
    "setupCommands",
    "cadence",
    "approvalClass",
    "goal",
    "constraints",
    "hints",
    "maxAttempts",
    "maxFanout",
    "maxGenerationTokens",
    "deploymentUrl",
  ]);
  if (Object.keys(input).some((k) => !keys.has(k)))
    fail(
      "Configuration contains an unsupported field. Never send credentials to this endpoint.",
    );
  // Explicit projection: no credentials, extra generator switches or arbitrary paths accepted.
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository || ""))
    fail("Repository must be owner/name.");
  const branch = defaultBranch || input.defaultBranch || "main";
  if (
    !/^[A-Za-z0-9_./-]+$/.test(branch) ||
    branch.includes("..") ||
    branch.startsWith("-")
  )
    fail("Invalid default branch.");
  const watched = list(input.labs, "Labs");
  if (!watched.length) fail("Choose at least one lab.");
  const provider = (name) => {
    const found = LABS.find((p) => p.name === name);
    if (!found) fail(`Unknown lab: ${name}`);
    return found;
  };
  // A pinned seat takes a model ID and, optionally, the lab that serves it.
  // The lab is not decoration: without it an ID is only usable if it happens
  // to match a provider pattern written before that model existed, which is
  // precisely the wrong constraint for a tool whose whole purpose is running
  // models that shipped after it did. Name the lab and any ID works.
  const seat = (value, labName, name, optional = false) => {
    if (!value && optional) return { model: null, provider: null };
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,150}$/.test(value)
    )
      fail(`Enter a valid ${name} model ID.`);
    if (labName) return { model: value, provider: provider(labName).name };
    try {
      return { model: value, provider: resolveProvider(value) };
    } catch {
      fail(
        `The ${name} model ID "${value}" does not name a lab this harness recognises. Choose its lab so the run knows who to call.`,
      );
    }
  };
  const implementSeat = seat(input.implementModel, input.implementProvider, "implementer");
  const reviewSeat = seat(input.reviewModel, input.reviewProvider, "reviewer");
  const rankSeat = seat(input.rankModel, input.rankProvider, "ranker", true);
  const implementModel = implementSeat.model;
  const reviewModel = reviewSeat.model;
  const rankModel = rankSeat.model;
  const allowedPaths = pathList(input.allowedPaths, "Editable paths");
  const createOnlyPaths = pathList(input.createOnlyPaths, "Create-only paths");
  const frozenPaths = [
    ...new Set([
      ...PROTECTED,
      ...pathList(input.frozenPaths, "Protected paths"),
    ]),
  ];
  if (!allowedPaths.length && !createOnlyPaths.length)
    fail("Allow at least one editable or create-only path.");
  for (const p of [...allowedPaths, ...createOnlyPaths]) {
    const prefix = p.split(/[?*]/)[0];
    if (
      !prefix ||
      PROTECTED.some(
        (f) =>
          globToRegExp(f).test(prefix) ||
          prefix.startsWith(f.replace(/\*.*$/, "")),
      )
    )
      fail(`Cannot allow protected path: ${p}`);
    if (frozenPaths.some((f) => globToRegExp(f).test(p)))
      fail(`Path is both allowed and protected: ${p}`);
  }
  if (tree) {
    for (const p of allowedPaths)
      if (!tree.some((f) => globToRegExp(p).test(f.path) && f.type === "blob"))
        fail(`No files match editable path: ${p}`);
    for (const p of allowedPaths)
      for (const f of tree)
        if (
          f.type === "blob" &&
          globToRegExp(p).test(f.path) &&
          frozenPaths.some((rule) => globToRegExp(rule).test(f.path))
        )
          fail(`Editable pattern includes protected file: ${f.path}`);
  }
  const setupCommands = list(
    input.setupCommands || [],
    "Dependency setup commands",
  );
  const testCommands = list(input.testCommands, "Test commands");
  if (!testCommands.length) fail("Add at least one real test command.");
  if (
    [...testCommands, ...setupCommands].some((c) => /\$\{\{|[\r\n\0]/.test(c))
  )
    fail(
      "Test commands must be single lines and cannot contain GitHub expressions.",
    );
  const cadence = { monthly: "0 0 1 * *", weekly: "0 0 * * 1", manual: null };
  if (!Object.hasOwn(cadence, input.cadence))
    fail("Choose monthly, weekly or manual cadence.");
  if (
    !["human-approval-required", "autonomous-merge"].includes(
      input.approvalClass,
    )
  )
    fail("Choose a valid approval mode.");
  if (input.approvalClass === "autonomous-merge" || input.deploymentUrl) {
    try {
      const u = new URL(input.deploymentUrl);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        /[\r\n]/.test(input.deploymentUrl)
      )
        throw new Error();
    } catch {
      fail(
        "Automatic merge requires a valid HTTPS deployment verification URL.",
      );
    }
  }
  const goal = prose(input.goal, "a project goal");
  const constraints = prose(input.constraints, "project constraints");
  const hints =
    typeof input.hints === "string" ? input.hints.trim().slice(0, 16000) : "";
  const answers = {
    projectId: input.repository.split("/")[1],
    repository: `https://github.com/${input.repository}`,
    defaultBranch: branch,
    harnessVersion: harnessVersion(),
    providers: watched.map(provider),
    roleProviders: [
      ...new Set(
        [implementSeat, reviewSeat, rankSeat]
          .map((s) => s.provider)
          .filter(Boolean),
      ),
    ].map(provider),
    implementModel,
    reviewModel,
    rankModel,
    // Written into project-adapter.yml only when the lab could not have been
    // read off the model ID — see scaffold.mjs's buildAdapterObject().
    implementProvider: input.implementProvider ? implementSeat.provider : "",
    reviewProvider: input.reviewProvider ? reviewSeat.provider : "",
    rankProvider: input.rankProvider ? rankSeat.provider : "",
    allowedPaths,
    createOnlyPaths,
    frozenPaths,
    testCommands,
    goalStatement: goal,
    goalHolds: [constraints],
    maxAttempts: integer(input.maxAttempts, 1, 5, "Attempts"),
    maxFanout: integer(input.maxFanout, 1, 9, "Fan-out"),
    maxGenerationTokens: integer(
      input.maxGenerationTokens,
      10000,
      10000000,
      "Token budget",
    ),
    // The first campaign always uses PR promotion, even if eventual auto-merge is requested.
    approvalClass: "human-approval-required",
    includeSchedule: false,
    cadenceCron: cadence[input.cadence],
    deploymentStrategy: input.deploymentUrl ? "url" : "none",
    deploymentUrl: input.deploymentUrl
      ? { productionUrl: input.deploymentUrl, watchedFiles: allowedPaths }
      : undefined,
    ambition: "focused",
    // A shared installation records its pin, and keeps the setup commands in
    // the adapter, where the shared workflow reads them each run.
    ...(shared ? { sharedHarness: shared, setupCommands } : {}),
  };
  const bullet = (items) => items.map((x) => `- ${x}`).join("\n") || "- None";
  const agentBrief = `# ${answers.projectId}: improvement brief\n\n## Objective\n${goal}\n\n## Constraints\n${constraints}\n\n## Quality bar\n${hints || "Preserve existing behaviour and explain the benefit of each change."}\n\nMake one focused, reviewable improvement. Respect the committed goal and all protected paths. Use exact edits. Never change tests to hide a failure.\n\n## Editable paths\n${bullet(allowedPaths)}\n\n## Create-only paths\n${bullet(createOnlyPaths)}\n\n## Protected paths\n${bullet(frozenPaths)}\n\n## Tests that must pass\n${bullet(testCommands)}\n\nEnd every proposal with BRIEF FEEDBACK: describing what helped or constrained you. You may argue for changing a rule using ESCALATION:, ESCALATION TARGET:, and ESCALATION CASE:, but may never edit the rule yourself.\n`;
  const reviewerBrief = `# Independent review\n\nReview the actual changes against this objective:\n${goal}\n\nConstraints:\n${constraints}\n\nReject broken behaviour, weak or bypassed tests, changes outside allowed paths, goal drift and unresolved required fixes. Test commands:\n${bullet(testCommands)}\n\nReturn exactly one verdict, either VERDICT: APPROVED or VERDICT: REJECTED, followed by REASON: and any REQUIRED FIXES:. An approval must have no required fixes. End with END OF REVIEW.\n`;
  const files = {
    "project-adapter.yml": renderAdapterYaml(answers),
    [WORKFLOW]: shared
      ? renderCallerWorkflow(answers)
      : workflowFor(answers, setupCommands),
    ".claude/agents/improve.md": agentBrief,
    ".claude/agents/review.md": reviewerBrief,
    "SELF-IMPROVE-README.md":
      renderReadme(answers) +
      (setupCommands.length
        ? "\n## Project dependency setup\n\n" +
          (shared
            ? "Runs before this project's tests, from `evaluation.setup_commands`:"
            : "Runs before harness dependencies are installed:") +
          "\n\n```sh\n" +
          setupCommands.join("\n") +
          "\n```\n"
        : ""),
  };
  return {
    answers,
    files,
    requiredSecrets: requiredProviders(answers).map((p) => p.envKey),
    requestedApproval: input.approvalClass,
    requestedCadence: input.cadence,
    warnings: [
      "The setup workflow is manual and opens pull requests. Scheduling and automatic merge remain off during rehearsal.",
      ...(shared
        ? [
            `The workflow calls the shared harness at ${shared.label || shared.ref} from ${shared.repository}. That repository must be readable by this repository's Actions runs.`,
          ]
        : []),
      "Test commands execute in your GitHub Actions runner. Include any dependency installation your tests need.",
      ...(implementSeat.provider === reviewSeat.provider
        ? [
            "Implementer and reviewer use the same lab. Consider a different lab for independent judgement.",
          ]
        : []),
    ],
  };
}
export function harnessFiles(sourceRoot = root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(sourceRoot + dir, {
      withFileTypes: true,
    })) {
      const p = dir + "/" + entry.name;
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules"
      )
        walk(p);
      else if (
        entry.isFile() &&
        (entry.name === "VERSION" ||
          entry.name === ".env.example" ||
          (!entry.name.startsWith(".") &&
            /\.(mjs|md|json|yml|tmpl)$/.test(entry.name)))
      )
        files[p] = fs.readFileSync(sourceRoot + p, "utf8");
    }
  };
  walk("harness");
  return files;
}

export function activationFiles(input, { shared = null } = {}) {
  const generated = configure(input, { shared });
  const answers = {
    ...generated.answers,
    includeSchedule: input.cadence !== "manual",
    approvalClass: input.approvalClass,
  };
  return {
    "project-adapter.yml": renderAdapterYaml(answers),
    [WORKFLOW]: shared
      ? renderCallerWorkflow(answers)
      : workflowFor(answers, input.setupCommands || []),
  };
}

/**
 * Whether this deployment installs the shared harness instead of copying
 * harness/ into each repository, from SELF_OPTIMISATION_SHARED_REF (a full
 * commit SHA), SELF_OPTIMISATION_SHARED_REPOSITORY and
 * SELF_OPTIMISATION_SHARED_LABEL. Unset is the copied install. A value that
 * would not render is thrown at boot, so a deployment never opens pull
 * requests carrying a workflow that cannot run.
 */
export function sharedHarnessFromEnv(env = process.env) {
  if (!env.SELF_OPTIMISATION_SHARED_REF) return null;
  const shared = {
    repository: env.SELF_OPTIMISATION_SHARED_REPOSITORY || SHARED_HARNESS_REPOSITORY,
    ref: env.SELF_OPTIMISATION_SHARED_REF,
    ...(env.SELF_OPTIMISATION_SHARED_LABEL
      ? { label: env.SELF_OPTIMISATION_SHARED_LABEL }
      : {}),
  };
  try {
    renderCallerWorkflow({ sharedHarness: shared });
  } catch (error) {
    throw new Error(`SELF_OPTIMISATION_SHARED_*: ${error.message}`);
  }
  return shared;
}

export function requiredSecretNames(input) {
  const names = list(input.labs || [], "Labs");
  for (const [model, lab] of [
    [input.implementModel, input.implementProvider],
    [input.reviewModel, input.reviewProvider],
    [input.rankModel, input.rankProvider],
  ].filter(([model]) => model)) {
    if (lab) {
      names.push(lab);
      continue;
    }
    try {
      names.push(resolveProvider(model));
    } catch {
      fail(
        "A pinned model ID does not name a supported lab. Choose the lab for that seat.",
      );
    }
  }
  return [...new Set(names)].map((name) => {
    const p = LABS.find((l) => l.name === name);
    if (!p) fail("Unknown lab.");
    return p.envKey;
  });
}

function workflowFor(answers, setupCommands) {
  const workflow = renderWorkflowTemplate(template, answers);
  if (!setupCommands.length) return workflow;
  // Project package managers can remove a --no-save harness dependency. Run the
  // project's dependency setup FIRST, then the existing pinned harness install.
  // Anchored to the self-improve JOB, not merely to the first occurrence of
  // the step name. The generated workflow has a second job — check-keys —
  // which carries the same setup steps and comes first in the file.
  // Injecting at the first match put the project's dependency install into
  // the job that only ever calls lab APIs, and left the job that runs the
  // project's tests without it.
  const jobStart = workflow.indexOf("\n  self-improve:");
  if (jobStart === -1) throw new Error("generated workflow has no self-improve job");
  const marker = "      - name: Install harness dependencies";
  const setup =
    "      - name: Install project dependencies\n        shell: bash\n        run: |\n" +
    setupCommands.map((c) => "          " + c).join("\n") +
    "\n\n";
  const at = workflow.indexOf(marker, jobStart);
  if (at === -1) throw new Error("self-improve job has no harness install step");
  return workflow.slice(0, at) + setup + workflow.slice(at);
}
