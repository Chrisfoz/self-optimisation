import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inspectRepository,
  openSetup,
  dispatchRehearsal,
  rehearsalStatus,
  activateSchedule,
  repositories,
  githubClient,
} from "../../console/github.mjs";
import { configure, WORKFLOW } from "../../console/configuration.mjs";
const input = () => ({
  repository: "owner/project",
  defaultBranch: "main",
  labs: ["openai"],
  implementModel: "gpt-5",
  reviewModel: "claude-opus-5",
  rankModel: "",
  allowedPaths: ["src/app.js"],
  createOnlyPaths: ["tests/**"],
  frozenPaths: [],
  testCommands: ["npm test"],
  goal: "Improve the calculator.",
  constraints: "Preserve saved data.",
  hints: "",
  maxAttempts: 3,
  maxFanout: 2,
  maxGenerationTokens: 500000,
  cadence: "monthly",
  approvalClass: "human-approval-required",
  deploymentUrl: "",
});
const gateNames = [
  "Validate the project's adapter",
  "Probe reachability, then read the survivors",
  "Run this project's own tests (preflight — baseline must be green before spending anything)",
  "Run the improvement loop",
  "Guard — enforce frozen/append-only paths on the agent branch",
  "Run this project's own tests, against the agent branch",
  "Open a pull request, if every gate passed",
];
function fixture(overrides = {}) {
  const calls = [];
  const state = {
    installed: true,
    secrets: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    tree: [{ type: "blob", path: "src/app.js" }],
    head: "merge-sha",
    prHead: "setup-commit",
    merged: true,
    runConclusion: "success",
    gateFailure: null,
    ...overrides,
  };
  const api = async (route, options = {}) => {
    calls.push({ route, ...options });
    if (route.startsWith("/user/installations?"))
      return { installations: state.installed ? [{ id: 10 }] : [] };
    if (route.startsWith("/user/installations/10/repositories?"))
      return {
        repositories: [
          {
            full_name: "owner/project",
            default_branch: "main",
            permissions: { push: true },
          },
        ],
      };
    if (route === "/repos/owner/project") return { default_branch: "main" };
    if (route.includes("/branches/")) return { commit: { sha: state.head } };
    if (route.endsWith("/git/commits/" + state.head))
      return { tree: { sha: "base-tree" } };
    if (route.includes("/git/trees/base-tree?"))
      return { tree: state.tree, truncated: state.truncated };
    if (route.includes("/actions/secrets?"))
      return { secrets: state.secrets.map((name) => ({ name })) };
    if (route.endsWith("/git/trees") && options.method === "POST")
      return { sha: "new-tree" };
    if (route.endsWith("/git/commits") && options.method === "POST")
      return { sha: "setup-commit" };
    if (route.endsWith("/git/refs")) return { ref: options.body.ref };
    if (route.endsWith("/pulls") && options.method === "POST")
      return {
        number: 12,
        html_url: "https://github.com/owner/project/pull/12",
      };
    if (route.endsWith("/pulls/12"))
      return {
        head: { sha: state.prHead },
        merged: state.merged,
        merge_commit_sha: "merge-sha",
        state: state.merged ? "closed" : "open",
        html_url: "https://github.com/owner/project/pull/12",
      };
    if (route.includes("/actions/workflows/self-improve.yml/runs?"))
      return {
        workflow_runs: state.noRun
          ? []
          : [
              {
                id: 42,
                head_sha: state.runSha || "merge-sha",
                head_branch: "main",
                created_at: new Date(Date.now() + 1000).toISOString(),
                conclusion: state.runConclusion,
                status: "completed",
                html_url: "https://github.com/owner/project/actions/runs/42",
              },
            ],
      };
    if (route.includes("/actions/runs/42/jobs?"))
      return {
        jobs: [
          {
            steps: gateNames.map((name) => ({
              name,
              conclusion: name === state.gateFailure ? "skipped" : "success",
            })),
          },
        ],
      };
    if (route.endsWith("/dispatches")) return null;
    if (route.includes("/contents/")) {
      const name = route.split("/contents/")[1].split("?")[0];
      return {
        content: Buffer.from(
          state.configChanged ? "changed" : configure(input()).files[name],
        ).toString("base64"),
      };
    }
    throw new Error("Unexpected request " + route);
  };
  return { api, state, calls };
}
const setup = () => ({
  number: 12,
  head: "setup-commit",
  repository: "owner/project",
  model: "gpt-5",
  input: input(),
  dispatchedAt: Date.now() - 1000,
});
test("repository discovery includes only current writable installations", async () => {
  const f = fixture();
  assert.equal((await repositories(f.api))[0].name, "owner/project");
  f.state.installed = false;
  assert.deepEqual(await repositories(f.api), []);
  await assert.rejects(
    inspectRepository(f.api, "owner/project"),
    /currently granted/,
  );
});
test("repository uses default branch from GitHub and refuses truncated trees", async () => {
  const f = fixture();
  const repo = await inspectRepository(f.api, "owner/project");
  assert.equal(repo.head, "merge-sha");
  f.state.truncated = true;
  await assert.rejects(inspectRepository(f.api, "owner/project"), /too large/);
});
test("setup creates one atomic tree, one branch and a PR without writing the default branch", async () => {
  const f = fixture();
  const repo = await inspectRepository(f.api, "owner/project");
  const result = await openSetup(f.api, repo, input());
  assert.equal(result.number, 12);
  const tree = f.calls.find(
    (c) => c.route.endsWith("/git/trees") && c.method === "POST",
  ).body.tree;
  assert.ok(tree.some((f) => f.path === "harness/scripts/run-generation.mjs"));
  assert.ok(tree.some((f) => f.path === WORKFLOW));
  assert.equal(
    f.calls.filter((c) => c.method === "POST" && c.route.endsWith("/git/trees"))
      .length,
    1,
  );
  const ref = f.calls.find((c) => c.route.endsWith("/git/refs")).body.ref;
  assert.match(ref, /^refs\/heads\/self-optimisation\/setup-/);
  assert.ok(!f.calls.some((c) => c.method === "PATCH"));
});
test("existing installation or missing secrets produces no writes", async () => {
  for (const values of [
    { secrets: [] },
    {
      tree: [
        { path: "src/app.js", type: "blob" },
        { path: "harness/VERSION", type: "blob" },
      ],
    },
  ]) {
    const f = fixture(values);
    const repo = await inspectRepository(f.api, "owner/project");
    await assert.rejects(openSetup(f.api, repo, input()));
    assert.ok(!f.calls.some((c) => c.method === "POST"));
  }
});
test("unmerged or edited setup cannot rehearse", async () => {
  for (const values of [{ merged: false }, { prHead: "edited" }]) {
    const f = fixture(values);
    const repo = await inspectRepository(f.api, "owner/project");
    await assert.rejects(
      dispatchRehearsal(f.api, repo, { ...setup(), dispatchedAt: null }),
      /Merge the unchanged/,
    );
    assert.ok(!f.calls.some((c) => c.route.endsWith("/dispatches")));
  }
});
test("rehearsal dispatch is explicit, focused, once, and on the verified default branch", async () => {
  const f = fixture({ noRun: true });
  const repo = await inspectRepository(f.api, "owner/project");
  const s = { ...setup(), dispatchedAt: null };
  await dispatchRehearsal(f.api, repo, s);
  const call = f.calls.find((c) => c.route.endsWith("/dispatches"));
  assert.deepEqual(call.body, {
    ref: "main",
    inputs: { scope: "focused", models: "gpt-5" },
  });
  await assert.rejects(dispatchRehearsal(f.api, repo, s), /already requested/);
});
test("default branch drift blocks console dispatch", async () => {
  const f = fixture({ head: "unreviewed" });
  const repo = await inspectRepository(f.api, "owner/project");
  await assert.rejects(
    dispatchRehearsal(f.api, repo, { ...setup(), dispatchedAt: null }),
    /default branch changed/,
  );
});
test("green workflow with skipped guard is not a passed rehearsal", async () => {
  const f = fixture({ gateFailure: gateNames[4] });
  const repo = await inspectRepository(f.api, "owner/project");
  assert.equal((await rehearsalStatus(f.api, repo, setup())).passed, false);
  await assert.rejects(activateSchedule(f.api, repo, setup()), /must pass/);
});
test("another commit or unrequested run is not proof of a rehearsal", async () => {
  const f = fixture({ runSha: "other" });
  const repo = await inspectRepository(f.api, "owner/project");
  assert.equal((await rehearsalStatus(f.api, repo, setup())).run, null);
  f.state.runSha = "merge-sha";
  assert.equal(
    (await rehearsalStatus(f.api, repo, { ...setup(), dispatchedAt: null }))
      .run,
    null,
  );
});
test("passed gates and unchanged config permit an activation PR, never a direct merge", async () => {
  const f = fixture();
  const repo = await inspectRepository(f.api, "owner/project");
  const result = await activateSchedule(f.api, repo, setup());
  assert.equal(result.number, 12);
  const tree = f.calls.find(
    (c) => c.route.endsWith("/git/trees") && c.method === "POST",
  ).body.tree;
  assert.equal(tree.length, 2);
  assert.match(
    tree.find((f) => f.path === WORKFLOW).content,
    /\n  schedule:\n/,
  );
  assert.ok(!f.calls.some((c) => c.route.endsWith("/merge")));
});
test("changed configuration cannot be activated from stale rehearsal evidence", async () => {
  const f = fixture({ configChanged: true });
  const repo = await inspectRepository(f.api, "owner/project");
  await assert.rejects(
    activateSchedule(f.api, repo, setup()),
    /changed since setup/,
  );
  assert.ok(!f.calls.some((c) => c.method === "POST"));
});
test("upstream errors never reflect token or response contents", async () => {
  const api = githubClient(
    "secret-token",
    async () => new Response("secret-token", { status: 403 }),
  );
  await assert.rejects(
    api("/user"),
    (error) => error.status === 403 && !error.message.includes("secret-token"),
  );
});
