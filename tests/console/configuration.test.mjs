import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import {
  configure,
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
  ["unknown model", { reviewModel: "mystery-model" }, /recognised/],
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
