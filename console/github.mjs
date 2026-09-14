/** GitHub App user-token client. Every repository operation checks the current installation grant. */
import { randomBytes } from "node:crypto";
import {
  configure,
  harnessFiles,
  WORKFLOW,
  activationFiles,
} from "./configuration.mjs";

export const problem = (status, message) =>
  Object.assign(new Error(message), { status });
export function githubClient(token, fetchImpl = fetch) {
  return async (route, { method = "GET", body } = {}) => {
    if (!route.startsWith("/") || route.startsWith("//"))
      throw problem(400, "Invalid GitHub route.");
    const response = await fetchImpl(`https://api.github.com${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "self-optimisation-console",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      // Never echo an upstream body: errors may include request values or credentials.
      const message =
        response.status === 401
          ? "GitHub sign-in expired. Sign in again."
          : response.status === 403
            ? "GitHub refused this operation. Check App permissions and repository access, or try again after the rate limit resets."
            : response.status === 404
              ? "GitHub could not find this resource, or access was removed."
              : response.status === 422
                ? "GitHub could not apply the change. Check the branch and repository settings."
                : "GitHub is temporarily unavailable. Try again.";
      throw problem(response.status, message);
    }
    return response.status === 204 ? null : response.json();
  };
}
async function pages(api, path, key) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const data = await api(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    const batch = key ? data[key] : data;
    if (!Array.isArray(batch))
      throw problem(502, "GitHub returned an invalid response.");
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw problem(
    422,
    "Too many GitHub results. Narrow the App installation to the repositories you need.",
  );
}
export async function repositories(api) {
  const installs = await pages(api, "/user/installations", "installations");
  const repos = [];
  for (const installation of installs) {
    if (installation.suspended_at) continue;
    const rows = await pages(
      api,
      `/user/installations/${installation.id}/repositories`,
      "repositories",
    );
    repos.push(
      ...rows
        .filter((r) => !r.archived && !r.disabled && r.permissions?.push)
        .map((r) => ({
          name: r.full_name,
          owner: r.owner?.login || r.full_name.split("/")[0],
          private: Boolean(r.private),
          description: r.description || "",
          defaultBranch: r.default_branch,
          installationId: installation.id,
        })),
    );
  }
  return [...new Map(repos.map((r) => [r.name, r])).values()];
}
export async function inspectRepository(api, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || ""))
    throw problem(422, "Repository must be owner/name.");
  const granted = (await repositories(api)).find(
    (r) => r.name.toLowerCase() === repository.toLowerCase(),
  );
  if (!granted)
    throw problem(
      403,
      "Select a repository currently granted to this GitHub App.",
    );
  const base = `/repos/${granted.name}`;
  const metadata = await api(base);
  if (metadata.size === 0)
    throw problem(422, "This repository is empty. Add an initial commit on GitHub, then connect again.");
  const branch = await api(
    `${base}/branches/${encodeURIComponent(metadata.default_branch)}`,
  );
  const commit = await api(`${base}/git/commits/${branch.commit.sha}`);
  const tree = await api(`${base}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated || tree.tree.length > 15000)
    throw problem(
      422,
      "This repository is too large for the current console. Use the command-line installer.",
    );
  return {
    name: granted.name,
    defaultBranch: metadata.default_branch,
    head: branch.commit.sha,
    treeSha: commit.tree.sha,
    tree: tree.tree,
    base,
  };
}
/**
 * The connected repository's own model snapshot — every model each watched
 * lab listed on that project's last detector run, written with that
 * project's keys. The console never holds a lab key (console/DESIGN.md
 * §2.2), so this file is the only route by which a live, account-accurate
 * model list can reach the picker.
 *
 * Absent is the normal case before the first run, not an error: a project
 * that has not run the detector yet simply has no live list, and the picker
 * falls back to the bundled catalogue. Anything unreadable — malformed
 * JSON, a file too large to be this, a path that turned out to be a
 * directory — is reported the same way, because none of them is worth
 * failing a setup screen over.
 *
 * @returns {Promise<{snapshot: object|null, path: string|null, readAt: string|null, reason: string|null}>}
 */
export async function repositorySnapshot(api, repo) {
  const blobs = repo.tree.filter((f) => f.type === "blob");
  const file =
    blobs.find((f) => f.path === ".agent/model-snapshot.json") ||
    blobs.find((f) => f.path.endsWith("/model-snapshot.json")) ||
    blobs.find((f) => f.path === "model-snapshot.json");
  if (!file)
    return {
      snapshot: null,
      path: null,
      readAt: null,
      reason:
        "No model snapshot in this repository yet. It is written the first time the release check runs.",
    };
  if (file.size > 524288)
    return { snapshot: null, path: file.path, readAt: null, reason: `${file.path} is too large to be a model snapshot.` };
  let content;
  try {
    content = await api(
      `${repo.base}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(repo.defaultBranch)}`,
    );
  } catch (error) {
    // A snapshot that cannot be fetched costs the picker its live half and
    // nothing else — never the screen.
    return { snapshot: null, path: file.path, readAt: null, reason: error.message };
  }
  try {
    const raw = Buffer.from(String(content.content || ""), "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return { snapshot: parsed, path: file.path, readAt: new Date().toISOString(), reason: null };
  } catch {
    return { snapshot: null, path: file.path, readAt: null, reason: `${file.path} could not be read as a model snapshot.` };
  }
}
export async function secretsStatus(api, repo, required) {
  const secrets = await pages(api, `${repo.base}/actions/secrets`, "secrets");
  const names = new Set(secrets.map((s) => s.name));
  return required.map((name) => ({ name, present: names.has(name) }));
}
export async function openSetup(api, repo, input, { shared = null } = {}) {
  const generated = configure(input, {
    tree: repo.tree,
    defaultBranch: repo.defaultBranch,
    shared,
  });
  // A shared installation calls the harness at a pinned commit; only a
  // copied one carries harness/ into the repository.
  const files = shared
    ? { ...generated.files }
    : { ...harnessFiles(), ...generated.files };
  const existing = new Set(repo.tree.map((f) => f.path));
  const collisions = Object.keys(files).filter((p) => existing.has(p));
  if (collisions.length)
    throw problem(
      409,
      `Setup would overwrite existing files (${collisions.slice(0, 4).join(", ")}). Use the CLI to upgrade an existing installation.`,
    );
  const missing = (
    await secretsStatus(api, repo, generated.requiredSecrets)
  ).filter((s) => !s.present);
  if (missing.length)
    throw problem(
      422,
      `Add these GitHub repository secrets first: ${missing.map((s) => s.name).join(", ")}`,
    );
  const branch = `self-optimisation/setup-${randomBytes(6).toString("hex")}`;
  // One atomic tree and commit: a failed request never writes to the default branch.
  const tree = await api(`${repo.base}/git/trees`, {
    method: "POST",
    body: {
      base_tree: repo.treeSha,
      tree: Object.entries(files).map(([path, content]) => ({
        path,
        mode: "100644",
        type: "blob",
        content,
      })),
    },
  });
  const commit = await api(`${repo.base}/git/commits`, {
    method: "POST",
    body: {
      message: "Configure governed self-improvement with a manual rehearsal",
      tree: tree.sha,
      parents: [repo.head],
    },
  });
  await api(`${repo.base}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
  let pr;
  try {
    pr = await api(`${repo.base}/pulls`, {
      method: "POST",
      body: {
        title: "Set up Self-Optimisation (manual rehearsal first)",
        head: branch,
        base: repo.defaultBranch,
        body: `${shared ? `Adds a workflow that calls the shared harness at ${shared.label || shared.ref}, plus the project goal, protected paths and test commands.` : "Adds the harness, project goal, protected paths and test commands."}\n\nThe initial workflow is dispatch-only and opens pull requests. It does not automatically merge or enable a schedule.\n\nReview the generated configuration and test commands before merging. Required secrets: ${generated.requiredSecrets.join(", ")}.\n\nAfter merging, return to the console to run a focused campaign on the selected implementer. Model API usage is billed to your configured keys.\n\nRequested later: ${input.cadence} checks; ${input.approvalClass}.`,
      },
    });
  } catch (error) {
    throw problem(
      error.status || 502,
      `${error.message} The setup branch ${branch} was created; inspect it on GitHub before retrying.`,
    );
  }
  return {
    number: pr.number,
    url: pr.html_url,
    head: commit.sha,
    repository: repo.name,
    branch: repo.defaultBranch,
    model: generated.answers.implementModel,
    createdAt: Date.now(),
    requestedCadence: input.cadence,
    requestedApproval: input.approvalClass,
    input: { ...input, defaultBranch: repo.defaultBranch },
    // Activation re-renders in the same mode, whatever the deployment says later.
    shared,
  };
}
export async function rehearsalStatus(api, repo, setup) {
  const pr = await api(`${repo.base}/pulls/${setup.number}`);
  if (pr.head.sha !== setup.head)
    return {
      merged: false,
      changed: true,
      message:
        "The setup pull request changed after creation. Review and rehearse it from GitHub Actions.",
    };
  if (!pr.merged) return { merged: false, state: pr.state, url: pr.html_url };
  const data = await api(
    `${repo.base}/actions/workflows/self-improve.yml/runs?event=workflow_dispatch&per_page=30`,
  );
  const run = data.workflow_runs.find(
    (r) =>
      r.head_sha === pr.merge_commit_sha &&
      r.head_branch === repo.defaultBranch &&
      Date.parse(r.created_at) >= (setup.dispatchedAt || Infinity),
  );
  if (!run) return { merged: true, run: null };
  const jobs = await pages(
    api,
    `${repo.base}/actions/runs/${run.id}/jobs`,
    "jobs",
  );
  const steps = jobs.flatMap((j) => j.steps || []);
  const names = [
    "Validate the project's adapter",
    "Probe reachability, then read the survivors",
    "Run this project's own tests (preflight — baseline must be green before spending anything)",
    "Run the improvement loop",
    "Guard — enforce frozen/append-only paths on the agent branch",
    "Run this project's own tests, against the agent branch",
    "Open a pull request, if every gate passed",
  ];
  const gates = names.map((name) => ({
    name,
    result: steps.find((s) => s.name === name)?.conclusion || "pending",
  }));
  return {
    merged: true,
    run: {
      id: run.id,
      url: run.html_url,
      status: run.status,
      conclusion: run.conclusion,
    },
    gates,
    passed:
      run.conclusion === "success" &&
      gates.every((g) => g.result === "success"),
  };
}
export async function dispatchRehearsal(api, repo, setup) {
  const state = await rehearsalStatus(api, repo, setup);
  if (!state.merged || state.changed)
    throw problem(
      409,
      "Merge the unchanged setup pull request before rehearsing.",
    );
  if (setup.dispatchedAt)
    throw problem(
      409,
      "A rehearsal was already requested. Refresh its status or use GitHub Actions to retry.",
    );
  const pr = await api(`${repo.base}/pulls/${setup.number}`);
  if (repo.head !== pr.merge_commit_sha)
    throw problem(
      409,
      "The default branch changed since setup merged. Review and run the workflow directly in GitHub Actions.",
    );
  setup.dispatchedAt = Date.now();
  try {
    await api(`${repo.base}/actions/workflows/self-improve.yml/dispatches`, {
      method: "POST",
      body: {
        ref: repo.defaultBranch,
        inputs: { scope: "focused", models: setup.model },
      },
    });
  } catch (e) {
    setup.dispatchedAt = null;
    throw e;
  }
  return { requested: true };
}

export async function activateSchedule(api, repo, setup) {
  const status = await rehearsalStatus(api, repo, setup);
  if (!status.passed)
    throw problem(
      409,
      "A rehearsal must pass review, guard, tests and pull-request creation before activation.",
    );
  const initial = configure(setup.input, { shared: setup.shared ?? null }).files;
  for (const p of ["project-adapter.yml", WORKFLOW]) {
    const file = await api(
      `${repo.base}/contents/${p}?ref=${encodeURIComponent(repo.head)}`,
    );
    if (Buffer.from(file.content, "base64").toString("utf8") !== initial[p])
      throw problem(
        409,
        "Configuration changed since setup. Review and activate it manually on GitHub.",
      );
  }
  if (
    setup.input.cadence === "manual" &&
    setup.input.approvalClass === "human-approval-required"
  )
    throw problem(
      409,
      "Manual mode is already active. No activation change is needed.",
    );
  const files = activationFiles(setup.input, { shared: setup.shared ?? null });
  const branch = `self-optimisation/activate-${randomBytes(6).toString("hex")}`;
  const tree = await api(`${repo.base}/git/trees`, {
    method: "POST",
    body: {
      base_tree: repo.treeSha,
      tree: Object.entries(files).map(([path, content]) => ({
        path,
        mode: "100644",
        type: "blob",
        content,
      })),
    },
  });
  const commit = await api(`${repo.base}/git/commits`, {
    method: "POST",
    body: {
      message: "Activate the reviewed self-improvement configuration",
      tree: tree.sha,
      parents: [repo.head],
    },
  });
  await api(`${repo.base}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
  const pr = await api(`${repo.base}/pulls`, {
    method: "POST",
    body: {
      title: "Activate Self-Optimisation after rehearsal",
      head: branch,
      base: repo.defaultBranch,
      body: `Rehearsal evidence: ${status.run.url}\n\nEnables ${setup.input.cadence} cadence and ${setup.input.approvalClass}. Review this diff before merging; recurring model usage is billed to your keys.`,
    },
  });
  return { number: pr.number, url: pr.html_url };
}

