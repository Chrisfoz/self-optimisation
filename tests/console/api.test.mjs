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
