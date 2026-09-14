/**
 * Where a lab request actually goes: the lab's own HTTPS host, or — for a
 * rehearsal that must not spend anything — a loopback stand-in.
 *
 * Every provider file names its lab's real hostname, and until this file
 * existed that was the only place a request could go. That was right for a
 * production run and wrong for the one thing the test suite could not do:
 * drive the real chain — the real scripts, the real prompt assembly, the
 * real parsers, real git — across the same HTTP boundary a real run
 * crosses, with only the lab's *answers* faked. Every test faked the call
 * one function above the transport instead, so the transport, the request
 * shapes, the auth headers and the list-models parsers were exercised only
 * by a real key or never.
 *
 * HARNESS_LAB_ENDPOINT=http://127.0.0.1:<port> sends every lab request to
 * that origin instead, keeping the lab's own path and headers and adding
 * `x-harness-upstream-host` so the stand-in can tell the labs apart. It
 * is honoured ONLY for a loopback address: a real key is in those headers,
 * and an environment variable that could quietly redirect it to any host on
 * the internet would be a credential exfiltration switch with a friendly
 * name. Anything else fails closed, loudly, before a byte is sent.
 *
 * tests/helpers/mock-labs.mjs is the stand-in this was written for.
 */

import http from 'node:http';
import https from 'node:https';

export const LAB_ENDPOINT_ENV = 'HARNESS_LAB_ENDPOINT';
export const UPSTREAM_HOST_HEADER = 'x-harness-upstream-host';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Resolve the transport for a request the provider addressed to `hostname`.
 *
 * @param {string} hostname  The lab's real hostname, from its provider file.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{request: typeof https.request, get: typeof https.get, hostname: string, port: number, headers: object, redirected: boolean}}
 */
export function resolveLabEndpoint(hostname, env = process.env) {
  const raw = env[LAB_ENDPOINT_ENV];
  if (!raw) {
    return { request: https.request, get: https.get, hostname, port: 443, headers: {}, redirected: false };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${LAB_ENDPOINT_ENV} is not a URL: ${JSON.stringify(raw)}`);
  }
  if (!LOOPBACK.has(url.hostname)) {
    throw new Error(
      `${LAB_ENDPOINT_ENV} must point at a loopback address (localhost, 127.0.0.1 or ::1), not ${url.hostname}. ` +
      'It carries real API keys in its headers and is only for a local stand-in.'
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${LAB_ENDPOINT_ENV} must be http:// or https://, not ${url.protocol}`);
  }
  const secure = url.protocol === 'https:';
  return {
    request: secure ? https.request : http.request,
    get: secure ? https.get : http.get,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || (secure ? 443 : 80),
    headers: { [UPSTREAM_HOST_HEADER]: hostname },
    redirected: true,
  };
}
