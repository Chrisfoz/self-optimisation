import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../../harness/vendor/js-yaml.mjs";
import {
  configure,
  activationFiles,
  sharedHarnessFromEnv,
  WORKFLOW,
} from "../../console/configuration.mjs";
import { openSetup } from "../../console/github.mjs";
import { createConsoleServer } from "../../console/server.mjs";
import { SHARED_HARNESS_REPOSITORY, SHARED_WORKFLOW_PATH } from "../../harness/lib/scaffold.mjs";

// A deployment with SELF_OPTIMISATION_SHARED_REF set installs the shared
// harness: each repository gets a short workflow calling it at that commit,
// and no copy of harness/.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const shared = { repository: SHARED_HARNESS_REPOSITORY, ref: SHA, label: "v0.1.0" };
const input = () => ({
  repository: "owner/project",
  defaultBranch: "main",
  labs: ["openai"],
  implementModel: "gpt-5",
  reviewModel: "gpt-5",
  rankModel: "",
  allowedPaths: ["src/app.js"],
  createOnlyPaths: [],
  frozenPaths: [],
  testCommands: ["npm test"],
  setupCommands: ["npm ci --ignore-scripts"],
  goal: "Improve the app.",
  constraints: "Preserve data.",
  hints: "",
  maxAttempts: 3,
  maxFanout: 2,
  maxGenerationTokens: 500000,
  cadence: "monthly",
  approvalClass: "human-approval-required",
  deploymentUrl: "",
});

test("sharedHarnessFromEnv: unset is the copied install, a bad pin stops the service", () => {
  assert.equal(sharedHarnessFromEnv({}), null);
  assert.deepEqual(
    sharedHarnessFromEnv({ SELF_OPTIMISATION_SHARED_REF: SHA, SELF_OPTIMISATION_SHARED_LABEL: "v0.1.0" }),
    shared,
  );
  for (const ref of ["main", "v0.1.0", SHA.slice(0, 12)])
    assert.throws(() => sharedHarnessFromEnv({ SELF_OPTIMISATION_SHARED_REF: ref }), /SELF_OPTIMISATION_SHARED_\*: .*40-character/);
  assert.throws(
    () => sharedHarnessFromEnv({ SELF_OPTIMISATION_SHARED_REF: SHA, SELF_OPTIMISATION_SHARED_REPOSITORY: "not a repo" }),
    /owner\/repository/,
  );
});

test("configure: a shared install writes a caller workflow and records the pin and setup commands", () => {
  const generated = configure(input(), { shared });
  const workflow = load(generated.files[WORKFLOW]);
  assert.equal(workflow.jobs["self-improve"].uses, `${SHARED_HARNESS_REPOSITORY}/${SHARED_WORKFLOW_PATH}@${SHA}`);
  assert.ok(!("schedule" in workflow.on), "rehearsal first: no schedule yet");
  const adapter = load(generated.files["project-adapter.yml"]);
  assert.deepEqual(adapter.harness.shared, shared);
  assert.deepEqual(adapter.evaluation.setup_commands, ["npm ci --ignore-scripts"]);
  assert.equal(adapter.constitution.approval_class, "human-approval-required", "the first campaign always opens a pull request");
  assert.match(generated.files["SELF-IMPROVE-README.md"], /No copy of `harness\/` lives in this repository/);
  assert.ok(generated.warnings.some((w) => w.includes("shared harness at v0.1.0")));
  assert.ok(!Object.keys(generated.files).some((p) => p.startsWith("harness/")));
});

test("configure: without a shared pin, the copied install is unchanged", () => {
  const generated = configure(input());
  const workflow = load(generated.files[WORKFLOW]);
  assert.ok(Array.isArray(workflow.jobs["self-improve"].steps));
  assert.equal(load(generated.files["project-adapter.yml"]).harness.shared, undefined);
});

test("activationFiles: a shared install turns the schedule on and keeps its pin", () => {
  const files = activationFiles({ ...input(), approvalClass: "autonomous-merge", deploymentUrl: "https://app.example" }, { shared });
  const workflow = load(files[WORKFLOW]);
  assert.deepEqual(workflow.on.schedule, [{ cron: "0 0 1 * *" }]);
  assert.ok(workflow.jobs["self-improve"].uses.endsWith(`@${SHA}`));
  assert.equal(load(files["project-adapter.yml"]).constitution.approval_class, "autonomous-merge");
});

test("openSetup: a shared install commits no harness files, and the pull request says what it calls", async () => {
  const calls = [];
  const api = async (route, options = {}) => {
    calls.push({ route, ...options });
    if (route.includes("/actions/secrets?")) return { secrets: [{ name: "OPENAI_API_KEY" }] };
    if (route.endsWith("/git/trees") && options.method === "POST") return { sha: "new-tree" };
    if (route.endsWith("/git/commits") && options.method === "POST") return { sha: "setup-commit" };
    if (route.endsWith("/git/refs")) return {};
    if (route.endsWith("/pulls") && options.method === "POST") return { number: 7, html_url: "https://github.com/owner/project/pull/7" };
    throw new Error("Unexpected request " + route);
  };
  const repo = {
    name: "owner/project", defaultBranch: "main", head: "head", treeSha: "tree",
    tree: [{ type: "blob", path: "src/app.js" }], base: "/repos/owner/project",
  };
  const setup = await openSetup(api, repo, input(), { shared });
  const tree = calls.find((c) => c.route.endsWith("/git/trees") && c.method === "POST").body.tree;
  assert.ok(!tree.some((f) => f.path.startsWith("harness/")), "no copy of the harness");
  assert.ok(tree.find((f) => f.path === WORKFLOW).content.includes(`@${SHA}`));
  assert.match(calls.find((c) => c.route.endsWith("/pulls")).body.body, /calls the shared harness at v0\.1\.0/);
  assert.deepEqual(setup.shared, shared, "activation will re-render in the same mode");
});

test("the session and the bundle report the shared install, and a bad pin stops the server at boot", async (t) => {
  const env = { CONSOLE_ORIGIN: "https://console.example", SELF_OPTIMISATION_SHARED_REF: SHA, SELF_OPTIMISATION_SHARED_LABEL: "v0.1.0" };
  const instance = createConsoleServer({ env });
  await new Promise((r) => instance.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => instance.close(r)));
  const base = `http://127.0.0.1:${instance.address().port}`;

  const session = await (await fetch(base + "/api/session")).json();
  assert.deepEqual(session.install, { mode: "shared", repository: SHARED_HARNESS_REPOSITORY, ref: SHA, label: "v0.1.0" });
  const bundle = await (
    await fetch(base + "/api/bundle", {
      method: "POST",
      headers: { origin: "https://console.example", "content-type": "application/json" },
      body: JSON.stringify(input()),
    })
  ).json();
  assert.ok(!bundle.files["harness/VERSION"], "no copy of the harness in the bundle");
  assert.ok(bundle.files[WORKFLOW].includes(`@${SHA}`));

  assert.throws(() => createConsoleServer({ env: { ...env, SELF_OPTIMISATION_SHARED_REF: "main" } }), /40-character/);
  const copied = createConsoleServer({ env: { CONSOLE_ORIGIN: "https://console.example" } });
  await new Promise((r) => copied.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => copied.close(r)));
  const copiedSession = await (await fetch(`http://127.0.0.1:${copied.address().port}/api/session`)).json();
  assert.deepEqual(copiedSession.install, { mode: "copied" });
});
