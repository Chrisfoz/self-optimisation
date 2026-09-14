import { test } from "node:test";
import assert from "node:assert/strict";
import { createConsoleServer } from "../../console/server.mjs";
const valid = {
  repository: "owner/project",
  labs: ["openai"],
  implementModel: "gpt-5",
  reviewModel: "gpt-5",
  rankModel: "",
  allowedPaths: ["src/app.js"],
  createOnlyPaths: [],
  frozenPaths: [],
  testCommands: ["npm test"],
  goal: "Improve the app.",
  constraints: "Preserve data.",
  maxAttempts: 3,
  maxFanout: 2,
  maxGenerationTokens: 100000,
  cadence: "monthly",
  approvalClass: "human-approval-required",
};
async function server(t, options = {}) {
  const env = { CONSOLE_ORIGIN: "https://console.example", ...options.env };
  const instance = createConsoleServer({ ...options, env });
  await new Promise((r) => instance.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => instance.close(r)));
  return `http://127.0.0.1:${instance.address().port}`;
}
const post = (body, origin = "https://console.example", extra = {}) => ({
  method: "POST",
  headers: { origin, "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});
test("unconfigured app is explicit; public generation and complete bundle work without credentials", async (t) => {
  const base = await server(t);
  const state = await (await fetch(base + "/api/session")).json();
  assert.equal(state.configured, false);
  assert.equal(state.connected, false);
  const preview = await fetch(base + "/api/preview", post(valid));
  assert.equal(preview.status, 200);
  assert.ok((await preview.json()).files["project-adapter.yml"]);
  const bundle = await (await fetch(base + "/api/bundle", post(valid))).json();
  assert.ok(bundle.files["harness/VERSION"]);
  assert.equal(
    (await fetch(base + "/auth/github", { redirect: "manual" })).status,
    503,
  );
});
test("cross-origin, unsupported fields, invalid JSON and oversized payloads fail closed", async (t) => {
  const base = await server(t);
  assert.equal(
    (await fetch(base + "/api/preview", post(valid, "https://evil.example")))
      .status,
    403,
  );
  assert.equal(
    (
      await fetch(
        base + "/api/preview",
        post({ ...valid, apiKey: "never-send" }),
      )
    ).status,
    422,
  );
  const malformed = post(valid);
  malformed.body = "{";
  assert.equal((await fetch(base + "/api/preview", malformed)).status, 400);
  assert.equal(
    (
      await fetch(
        base + "/api/preview",
        post({ ...valid, goal: "x".repeat(140000) }),
      )
    ).status,
    413,
  );
});
test("private routes require sign-in; mutations additionally require CSRF", async (t) => {
  const sessions = new Map([
    [
      "session-id",
      {
        token: "secret",
        login: "owner",
        csrf: "csrf",
        expires: Date.now() + 60000,
      },
    ],
  ]);
  const base = await server(t, { sessions });
  assert.equal((await fetch(base + "/api/repositories")).status, 401);
  assert.equal(
    (
      await fetch(
        base + "/api/setup",
        post(valid, "https://console.example", {
          cookie: "__Host-console=session-id",
        }),
      )
    ).status,
    403,
  );
  const out = await fetch(
    base + "/auth/logout",
    post({}, "https://console.example", {
      cookie: "__Host-console=session-id",
      "x-csrf-token": "csrf",
    }),
  );
  assert.equal(out.status, 200);
  assert.equal(sessions.size, 0);
});
test("OAuth binds a single-use state to the browser and uses PKCE; tokens never reach the page", async (t) => {
  const sessions = new Map(),
    calls = [];
  const base = await server(t, {
    sessions,
    env: {
      GITHUB_CLIENT_ID: "app-client",
      GITHUB_CLIENT_SECRET: "server-secret",
      GITHUB_APP_SLUG: "my-app",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/access_token"))
        return Response.json({ access_token: "user-token", expires_in: 28800 });
      if (url.endsWith("/user")) return Response.json({ login: "owner" });
      throw new Error("Unexpected request");
    },
  });
  const start = await fetch(base + "/auth/github", { redirect: "manual" });
  assert.equal(start.status, 302);
  const redirect = new URL(start.headers.get("location"));
  assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
  assert.equal(redirect.searchParams.get("code_challenge").length, 43);
  const cookie = start.headers.get("set-cookie").split(";")[0];
  assert.match(
    start.headers.get("set-cookie"),
    /HttpOnly; SameSite=Lax; Max-Age=600; Secure/,
  );
  const url =
    base +
    "/auth/callback?code=example-code&state=" +
    redirect.searchParams.get("state");
  const result = await fetch(url, { redirect: "manual", headers: { cookie } });
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "/console");
  assert.equal(sessions.size, 1);
  const args = JSON.parse(calls[0].options.body);
  assert.equal(args.client_secret, "server-secret");
  assert.ok(args.code_verifier);
  const state = await (
    await fetch(base + "/api/session", {
      headers: { cookie: result.headers.get("set-cookie").split(";")[0] },
    })
  ).text();
  assert.doesNotMatch(state, /user-token|server-secret/);
  assert.equal(
    (await fetch(url, { redirect: "manual", headers: { cookie } })).status,
    400,
  );
});
test("OAuth rejects missing browser binding without exchanging a code", async (t) => {
  let exchanged = false;
  const base = await server(t, {
    env: {
      GITHUB_CLIENT_ID: "app-client",
      GITHUB_CLIENT_SECRET: "server-secret",
      GITHUB_APP_SLUG: "my-app",
    },
    fetchImpl: async () => {
      exchanged = true;
      throw new Error();
    },
  });
  const start = await fetch(base + "/auth/github", { redirect: "manual" });
  const state = new URL(start.headers.get("location")).searchParams.get(
    "state",
  );
  assert.equal(
    (
      await fetch(base + "/auth/callback?code=x&state=" + state, {
        redirect: "manual",
      })
    ).status,
    400,
  );
  assert.equal(exchanged, false);
});
test("expired sessions cannot read or mutate repository state", async (t) => {
  const sessions = new Map([
    ["old", { token: "secret", csrf: "csrf", expires: Date.now() - 1 }],
  ]);
  const base = await server(t, { sessions });
  assert.equal(
    (
      await fetch(base + "/api/repositories", {
        headers: { cookie: "__Host-console=old" },
      })
    ).status,
    401,
  );
  assert.equal(sessions.size, 0);
});

test('malformed request URLs return 400 without stopping the service', async (t) => {
  const { request } = await import('node:http');
  const base = await server(t);
  const code = await new Promise((resolve, reject) => {
    const req = request(new URL(base), { path: '//' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(code, 400);
  assert.equal((await fetch(base + '/healthz')).status, 200);
});


test('installation return ignores untrusted installation IDs and resumes discovery', async (t) => {
  const sessions = new Map([['active', { token: 'secret', login: 'owner', csrf: 'csrf', expires: Date.now() + 60000 }]]);
  const base = await server(t, { sessions });
  const guest = await fetch(base + '/auth/installed?installation_id=999', { redirect: 'manual' });
  assert.equal(guest.headers.get('location'), '/auth/github');
  const connected = await fetch(base + '/auth/installed?installation_id=999', {
    redirect: 'manual', headers: { cookie: '__Host-console=active' },
  });
  assert.equal(connected.headers.get('location'), '/console?github=installed');
  assert.equal(sessions.get('active').installationId, undefined);
});

test('cancelled OAuth returns to the console and consumes its browser-bound state', async (t) => {
  let exchanged = false;
  const base = await server(t, {
    env: { GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', GITHUB_APP_SLUG: 'app' },
    fetchImpl: async () => { exchanged = true; throw new Error('unexpected'); },
  });
  const start = await fetch(base + '/auth/github', { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const options = { redirect: 'manual', headers: { cookie: start.headers.get('set-cookie').split(';')[0] } };
  const url = base + '/auth/callback?error=access_denied&state=' + state;
  const cancelled = await fetch(url, options);
  assert.equal(cancelled.headers.get('location'), '/console?github=cancelled');
  assert.equal(exchanged, false);
  assert.equal((await fetch(url, options)).status, 400);
});

test('revoked user tokens invalidate the local session', async (t) => {
  const sessions = new Map([['active', { token: 'revoked', csrf: 'csrf', expires: Date.now() + 60000 }]]);
  const base = await server(t, { sessions, fetchImpl: async () => Response.json({}, { status: 401 }) });
  const result = await fetch(base + '/api/repositories', { headers: { cookie: '__Host-console=active' } });
  assert.equal(result.status, 401);
  assert.equal(sessions.size, 0);
});

test('non-ASCII CSRF values fail closed without a timingSafeEqual exception', async (t) => {
  const sessions = new Map([['active', { token: 'secret', csrf: 'aa', expires: Date.now() + 60000 }]]);
  const base = await server(t, { sessions });
  const result = await fetch(base + '/auth/logout', post({}, 'https://console.example', {
    cookie: '__Host-console=active', 'x-csrf-token': 'éé',
  }));
  assert.equal(result.status, 403);
  assert.equal(sessions.size, 1);
});

test("the model list is public before a repository, and live once there is one", async (t) => {
  // The console holds no lab key, so the only live catalogue it can offer is
  // the connected project's own snapshot, written by that project's last run.
  const snapshot = {
    openai: ["gpt-6-astra", "atlas-1"],
    _unfixable: { openai: { "atlas-0": { generation: 3 } } },
  };
  const sessions = new Map([
    ["active", { token: "secret", login: "owner", csrf: "csrf", expires: Date.now() + 60000 }],
  ]);
  const base = await server(t, {
    sessions,
    fetchImpl: async (url) => {
      const route = url.replace("https://api.github.com", "");
      if (route.startsWith("/user/installations?"))
        return Response.json({ installations: [{ id: 10 }] });
      if (route.startsWith("/user/installations/10/repositories?"))
        return Response.json({
          repositories: [
            { full_name: "owner/project", default_branch: "main", permissions: { push: true } },
          ],
        });
      if (route === "/repos/owner/project") return Response.json({ default_branch: "main", size: 40 });
      if (route.includes("/branches/")) return Response.json({ commit: { sha: "head-sha" } });
      if (route.endsWith("/git/commits/head-sha")) return Response.json({ tree: { sha: "base-tree" } });
      if (route.includes("/git/trees/base-tree?"))
        return Response.json({
          tree: [
            { type: "blob", path: "src/app.js", size: 10 },
            { type: "blob", path: ".agent/model-snapshot.json", size: 120 },
          ],
        });
      if (route.includes("/contents/.agent/model-snapshot.json"))
        return Response.json({ content: Buffer.from(JSON.stringify(snapshot)).toString("base64") });
      throw new Error("Unexpected request: " + route);
    },
  });

  const shipped = await (await fetch(base + "/api/models")).json();
  assert.equal(shipped.repository, null);
  assert.equal(shipped.counts.repository, 0);
  assert.ok(shipped.counts.bundled > 0);

  const live = await (
    await fetch(base + "/api/models?repository=owner/project", {
      headers: { cookie: "__Host-console=active" },
    })
  ).json();
  assert.equal(live.repository, "owner/project");
  assert.equal(live.snapshotPath, ".agent/model-snapshot.json");
  assert.ok(live.snapshotReadAt);
  const openai = live.labs.find((l) => l.name === "openai");
  const atlas = openai.models.find((m) => m.id === "atlas-1");
  assert.equal(atlas.unseen, true);
  assert.equal(atlas.needsLab, true);
  // The diagnostic ledger is not a lab and never becomes a pickable model.
  assert.ok(!live.labs.some((l) => l.name === "_unfixable"));

  // Signed out, the same query is refused rather than quietly answered from
  // the bundled list: it names someone's repository.
  assert.equal((await fetch(base + "/api/models?repository=owner/project")).status, 401);
});

test("one session opens a setup pull request per repository, not one in total", async (t) => {
  const sessions = new Map([
    ["active", { token: "secret", login: "owner", csrf: "csrf", expires: Date.now() + 60000 }],
  ]);
  const names = ["owner/alpha", "owner/beta"];
  const opened = [];
  const base = await server(t, {
    sessions,
    fetchImpl: async (url, options = {}) => {
      const route = url.replace("https://api.github.com", "");
      const method = options.method || "GET";
      if (route.startsWith("/user/installations?"))
        return Response.json({ installations: [{ id: 10 }] });
      if (route.startsWith("/user/installations/10/repositories?"))
        return Response.json({
          repositories: names.map((full_name) => ({
            full_name,
            default_branch: "main",
            permissions: { push: true },
          })),
        });
      const [, repo, rest] = route.match(/^\/repos\/(owner\/[a-z]+)(.*)$/) || [];
      if (!repo) throw new Error("Unexpected request: " + route);
      const short = repo.split("/")[1];
      if (rest === "") return Response.json({ default_branch: "main", size: 40 });
      if (rest.startsWith("/branches/")) return Response.json({ commit: { sha: `head-${short}` } });
      if (rest === `/git/commits/head-${short}`) return Response.json({ tree: { sha: `tree-${short}` } });
      if (rest.startsWith(`/git/trees/tree-${short}?`))
        return Response.json({ tree: [{ type: "blob", path: "src/app.js", size: 10 }] });
      if (rest.startsWith("/actions/secrets?"))
        return Response.json({ secrets: [{ name: "OPENAI_API_KEY" }] });
      if (method === "POST" && rest === "/git/trees") return Response.json({ sha: `new-tree-${short}` });
      if (method === "POST" && rest === "/git/commits") return Response.json({ sha: `setup-${short}` });
      if (method === "POST" && rest === "/git/refs") return Response.json({});
      if (method === "POST" && rest === "/pulls") {
        opened.push(repo);
        return Response.json({
          number: opened.length,
          html_url: `https://github.com/${repo}/pull/${opened.length}`,
        });
      }
      if (rest.startsWith("/pulls/"))
        return Response.json({ head: { sha: `setup-${short}` }, merged: false, state: "open" });
      throw new Error("Unexpected request: " + route);
    },
  });
  const signedIn = { cookie: "__Host-console=active", "x-csrf-token": "csrf" };
  const send = async (path, body) => {
    const response = await fetch(base + path, post(body, "https://console.example", signedIn));
    return { status: response.status, body: await response.json() };
  };

  // Before any setup, a repository has nothing to rehearse.
  const early = await send("/api/rehearse", { repository: "owner/beta" });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Create a setup pull request for this repository/);

  const alpha = await send("/api/setup", { ...valid, repository: "owner/alpha" });
  assert.equal(alpha.status, 201, alpha.body.error);
  const beta = await send("/api/setup", { ...valid, repository: "owner/beta" });
  assert.equal(beta.status, 201, beta.body.error);
  assert.deepEqual(opened, ["owner/alpha", "owner/beta"]);

  // The same repository twice is still refused, and opens nothing.
  const again = await send("/api/setup", { ...valid, repository: "owner/beta" });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already opened setup pull request #2 for owner\/beta/);
  assert.equal(opened.length, 2);

  // Each repository's actions reach its own setup, not the most recent one.
  const rehearse = await send("/api/rehearse", { repository: "owner/beta" });
  assert.equal(rehearse.status, 409);
  assert.match(rehearse.body.error, /Merge the unchanged setup/);
  const status = await (
    await fetch(base + "/api/setup?repository=owner/alpha", {
      headers: { cookie: "__Host-console=active" },
    })
  ).json();
  assert.equal(status.setup.number, 1);
  assert.equal(status.setup.repository, "owner/alpha");
  assert.equal(status.state, "open");
});

test("a repository with no snapshot still returns the bundled list, and says why", async (t) => {
  const sessions = new Map([
    ["active", { token: "secret", login: "owner", csrf: "csrf", expires: Date.now() + 60000 }],
  ]);
  const base = await server(t, {
    sessions,
    fetchImpl: async (url) => {
      const route = url.replace("https://api.github.com", "");
      if (route.startsWith("/user/installations?"))
        return Response.json({ installations: [{ id: 10 }] });
      if (route.startsWith("/user/installations/10/repositories?"))
        return Response.json({
          repositories: [
            { full_name: "owner/project", default_branch: "main", permissions: { push: true } },
          ],
        });
      if (route === "/repos/owner/project") return Response.json({ default_branch: "main", size: 40 });
      if (route.includes("/branches/")) return Response.json({ commit: { sha: "head-sha" } });
      if (route.endsWith("/git/commits/head-sha")) return Response.json({ tree: { sha: "base-tree" } });
      if (route.includes("/git/trees/base-tree?"))
        return Response.json({ tree: [{ type: "blob", path: "src/app.js", size: 10 }] });
      throw new Error("Unexpected request: " + route);
    },
  });
  const live = await (
    await fetch(base + "/api/models?repository=owner/project", {
      headers: { cookie: "__Host-console=active" },
    })
  ).json();
  assert.equal(live.counts.repository, 0);
  assert.ok(live.counts.bundled > 0);
  assert.match(live.snapshotReason, /No model snapshot/);
});
