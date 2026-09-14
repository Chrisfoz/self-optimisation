import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import {
  LABS,
  PROTECTED,
  configure,
  harnessFiles,
  modelCatalogue,
  requiredSecretNames,
} from "./configuration.mjs";
import {
  githubClient,
  repositories,
  inspectRepository,
  repositorySnapshot,
  secretsStatus,
  openSetup,
  rehearsalStatus,
  dispatchRehearsal,
  activateSchedule,
  problem,
} from "./github.mjs";
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const id = () => randomBytes(32).toString("hex");
export function createApi({
  env = process.env,
  fetchImpl = fetch,
  sessions = new Map(),
  now = Date.now,
} = {}) {
  const origin = env.CONSOLE_ORIGIN || "http://localhost:3000";
  if (new URL(origin).origin !== origin)
    throw new Error(
      "CONSOLE_ORIGIN must be an origin without a trailing slash or path.",
    );
  const secure = origin.startsWith("https://");
  const ready = Boolean(
    env.GITHUB_CLIENT_ID &&
    env.GITHUB_CLIENT_SECRET &&
    env.GITHUB_APP_SLUG &&
    env.CONSOLE_ORIGIN,
  );
  if (ready && !secure && !/^http:\/\/localhost(:\d+)?$/.test(origin))
    throw new Error("CONSOLE_ORIGIN must use HTTPS, except localhost.");
  const cookieName = secure ? "__Host-console" : "console_dev";
  const cookie = (value, age) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const pending = new Map();
  return async function api(req, res, url, send) {
    const path = url.pathname;
    if (!path.startsWith("/api/") && !path.startsWith("/auth/")) return false;
    const json = (status, data, headers = {}) =>
      send(status, "application/json; charset=utf-8", JSON.stringify(data), {
        "cache-control": "no-store",
        ...headers,
      });
    const redirect = (where, headers = {}) =>
      send(302, "text/plain; charset=utf-8", "Redirecting", {
        location: where,
        "cache-control": "no-store",
        ...headers,
      });
    try {
      for (const [key, s] of sessions)
        if (s.expires <= now()) sessions.delete(key);
      for (const [key, s] of pending)
        if (s.expires <= now()) pending.delete(key);
      const cookies = Object.fromEntries(
        (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")),
      );
      const sid = cookies[cookieName];
      const session = sessions.get(sid);
      if (req.method === "GET" && path === "/api/session") {
        json(200, {
          configured: ready,
          connected: Boolean(session),
          login: session?.login || null,
          csrf: session?.csrf || null,
          installUrl: ready
            ? `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`
            : null,
        });
        return true;
      }
      if (req.method === "GET" && path === "/api/catalog") {
        json(200, { labs: LABS, protectedPaths: PROTECTED });
        return true;
      }
      // The model pick-list. Without a repository this is the catalogue this
      // deploy shipped with — no sign-in needed, because it is a fact about
      // this deploy, not about anyone's account. With one (below, after the
      // session check) it also carries that project's live snapshot.
      if (
        req.method === "GET" &&
        path === "/api/models" &&
        !url.searchParams.get("repository")
      ) {
        json(200, { ...modelCatalogue(), repository: null, snapshotPath: null, snapshotReason: null });
        return true;
      }
      // Installation query parameters are navigation hints, never proof of access.
      // Repository discovery always rechecks the authenticated user's grants.
      if (req.method === "GET" && path === "/auth/installed") {
        redirect(session ? "/console?github=installed" : "/auth/github");
        return true;
      }
      if (req.method === "GET" && path === "/auth/github") {
        if (!ready)
          throw problem(
            503,
            "GitHub sign-in is not configured. Set the console GitHub App environment variables.",
          );
        if (pending.size >= 1000)
          throw problem(429, "Too many sign-in requests. Try again shortly.");
        const state = id(),
          browserNonce = id(),
          verifier = id();
        pending.set(state, {
          nonce: browserNonce,
          verifier,
          expires: now() + 600000,
        });
        const query = new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          redirect_uri: origin + "/auth/callback",
          state,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        });
        redirect("https://github.com/login/oauth/authorize?" + query, {
          "set-cookie": cookie(browserNonce, 600),
        });
        return true;
      }
      if (req.method === "GET" && path === "/auth/callback") {
        const state = url.searchParams.get("state");
        const login = pending.get(state);
        pending.delete(state);
        if (
          !ready ||
          !login ||
          !equal(login.nonce, sid)
        )
          throw problem(
            400,
            "Sign-in expired or could not be verified. Start again.",
          );
        if (url.searchParams.get("error") || !url.searchParams.get("code")) {
          redirect("/console?github=cancelled", { "set-cookie": cookie("", 0) });
          return true;
        }
        const response = await fetchImpl(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              client_id: env.GITHUB_CLIENT_ID,
              client_secret: env.GITHUB_CLIENT_SECRET,
              code: url.searchParams.get("code"),
              redirect_uri: origin + "/auth/callback",
              code_verifier: login.verifier,
            }),
            signal: AbortSignal.timeout(20000),
          },
        );
        const token = await response.json();
        if (!response.ok || !token.access_token)
          throw problem(401, "GitHub sign-in failed. Start again.");
        const gh = githubClient(token.access_token, fetchImpl);
        const user = await gh("/user");
        const sessionId = id();
        if (sessions.size >= 1000)
          throw problem(
            503,
            "Console session capacity reached. Try again later.",
          );
        sessions.delete(sid);
        sessions.set(sessionId, {
          token: token.access_token,
          login: user.login,
          csrf: id(),
          expires: now() + Math.min(token.expires_in || 3600, 3600) * 1000,
          setups: new Map(),
          busy: false,
        });
        redirect("/console", { "set-cookie": cookie(sessionId, 3600) });
        return true;
      }
      if (req.method === "POST") {
        let sameOrigin = req.headers.origin === origin;
        if (!env.CONSOLE_ORIGIN && !ready) {
          try {
            const incoming = new URL(req.headers.origin);
            sameOrigin =
              incoming.host === req.headers.host &&
              ["http:", "https:"].includes(incoming.protocol);
          } catch {
            sameOrigin = false;
          }
        }
        if (!sameOrigin)
          throw problem(403, "Request origin could not be verified.");
        if (
          !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")
        )
          throw problem(415, "Use JSON for this request.");
      }
      if (
        req.method === "POST" &&
        ["/api/preview", "/api/bundle"].includes(path)
      ) {
        const data = await readJson(req);
        const generated = configure(data);
        json(200, {
          files:
            path === "/api/bundle"
              ? { ...harnessFiles(), ...generated.files }
              : generated.files,
          requiredSecrets: generated.requiredSecrets,
          warnings: generated.warnings,
        });
        return true;
      }
      if (!session)
        throw problem(401, "Sign in to GitHub to connect a repository.");
      if (
        req.method === "POST" &&
        !equal(req.headers["x-csrf-token"], session.csrf)
      )
        throw problem(
          403,
          "Session verification failed. Refresh and try again.",
        );
      if (req.method === "POST" && path === "/auth/logout") {
        sessions.delete(sid);
        json(200, { ok: true }, { "set-cookie": cookie("", 0) });
        return true;
      }
      const gh = githubClient(session.token, fetchImpl);
      if (req.method === "GET" && path === "/api/repositories") {
        json(200, { repositories: await repositories(gh) });
        return true;
      }
      const allowedGet = ["/api/repository", "/api/setup", "/api/runs", "/api/models"];
      const allowedPost = [
        "/api/secrets",
        "/api/setup",
        "/api/rehearse",
        "/api/activate",
      ];
      if (
        !(req.method === "GET" && allowedGet.includes(path)) &&
        !(req.method === "POST" && allowedPost.includes(path))
      )
        throw problem(404, "Endpoint not found.");
      const data = req.method === "POST" ? await readJson(req) : null;
      const name = data?.repository || url.searchParams.get("repository");
      const repo = await inspectRepository(gh, name);
      if (req.method === "GET" && path === "/api/repository") {
        json(200, {
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          tree: repo.tree.map((f) => ({ path: f.path, type: f.type })),
          existingSetup: repo.tree.some(
            (f) => f.path === "project-adapter.yml",
          ),
        });
        return true;
      }
      if (req.method === "GET" && path === "/api/models") {
        const { snapshot, path: snapshotPath, readAt, reason } = await repositorySnapshot(gh, repo);
        json(200, {
          ...modelCatalogue({ snapshot, snapshotReadAt: readAt }),
          repository: repo.name,
          snapshotPath,
          snapshotReason: reason,
        });
        return true;
      }
      if (req.method === "POST" && path === "/api/secrets") {
        json(200, {
          secrets: await secretsStatus(gh, repo, requiredSecretNames(data)),
        });
        return true;
      }
      if (req.method === "GET" && path === "/api/runs") {
        const runs = await gh(`${repo.base}/actions/runs?per_page=20`);
        json(200, {
          runs: runs.workflow_runs
            .filter((r) => r.path === WORKFLOW_PATH)
            .map((r) => ({
              id: r.id,
              name: r.display_title,
              status: r.status,
              conclusion: r.conclusion,
              url: r.html_url,
              createdAt: r.created_at,
            })),
        });
        return true;
      }
      // Setups are tracked per repository, so one sign-in can take several
      // projects through setup, rehearsal and activation side by side. Each
      // action only ever reaches the setup for the repository it names.
      session.setups ??= new Map();
      const setup = session.setups.get(repo.name);
      if (req.method === "GET" && path === "/api/setup") {
        json(
          200,
          setup
            ? { setup, ...(await rehearsalStatus(gh, repo, setup)) }
            : { setup: null },
        );
        return true;
      }
      if (session.busy)
        throw problem(409, "Another setup action is still running.");
      session.busy = true;
      try {
        if (path === "/api/setup") {
          if (setup)
            throw problem(
              409,
              `This session already opened setup pull request #${setup.number} for ${repo.name}. Refresh its status instead.`,
            );
          if (session.setups.size >= MAX_SETUPS_PER_SESSION)
            throw problem(
              409,
              `This session has opened ${MAX_SETUPS_PER_SESSION} setup pull requests. Sign out and in again to set up more repositories.`,
            );
          const created = await openSetup(gh, repo, data);
          session.setups.set(repo.name, created);
          json(201, { setup: created });
        } else {
          if (!setup)
            throw problem(
              409,
              "Create a setup pull request for this repository in this session first.",
            );
          if (path === "/api/activate") {
            if (setup.activation)
              throw problem(409, "An activation pull request already exists.");
            setup.activation = await activateSchedule(gh, repo, setup);
            json(201, { activation: setup.activation });
          } else json(200, await dispatchRehearsal(gh, repo, setup));
        }
      } finally {
        session.busy = false;
      }
      return true;
    } catch (error) {
      if (error.status === 401 && !path.startsWith("/auth/")) {
        const sid = (req.headers.cookie || "").split(";")
          .map((c) => c.trim()).find((c) => c.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
        sessions.delete(sid);
      }
      json(error.status || 502, {
        error: error.status
          ? error.message
          : "The request could not be completed. Try again.",
      });
      return true;
    }
  };
}
const WORKFLOW_PATH = ".github/workflows/self-improve.yml";
// Sessions live in server memory; this bounds what one of them can hold.
const MAX_SETUPS_PER_SESSION = 25;
export async function readJson(req) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > 131072) throw problem(413, "Configuration is too large.");
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw problem(400, "Invalid JSON.");
  }
}

