import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';

import { resolveLabEndpoint, LAB_ENDPOINT_ENV, UPSTREAM_HOST_HEADER } from '../../harness/lib/lab-endpoint.mjs';

test('unset: the lab\'s own host, over HTTPS on 443, with no extra header', () => {
  const ep = resolveLabEndpoint('api.anthropic.com', {});
  assert.equal(ep.hostname, 'api.anthropic.com');
  assert.equal(ep.port, 443);
  assert.equal(ep.request, https.request);
  assert.equal(ep.get, https.get);
  assert.deepEqual(ep.headers, {});
  assert.equal(ep.redirected, false);
});

test('a loopback endpoint redirects the request and names the lab it stood in for', () => {
  for (const [raw, host, port, mod] of [
    ['http://127.0.0.1:4010', '127.0.0.1', 4010, http],
    ['http://localhost:8080/', 'localhost', 8080, http],
    ['https://[::1]:9443', '::1', 9443, https],
    ['http://localhost', 'localhost', 80, http],
  ]) {
    const ep = resolveLabEndpoint('api.openai.com', { [LAB_ENDPOINT_ENV]: raw });
    assert.equal(ep.hostname, host, raw);
    assert.equal(ep.port, port, raw);
    assert.equal(ep.request, mod.request, raw);
    assert.deepEqual(ep.headers, { [UPSTREAM_HOST_HEADER]: 'api.openai.com' }, raw);
    assert.equal(ep.redirected, true);
  }
});

test('anything but loopback is refused — the header carries a real key', () => {
  for (const raw of ['https://example.com', 'http://10.0.0.5:80', 'http://evil.localhost.example', 'https://127.0.0.1.nip.io']) {
    assert.throws(() => resolveLabEndpoint('api.x.ai', { [LAB_ENDPOINT_ENV]: raw }), /loopback/, raw);
  }
  assert.throws(() => resolveLabEndpoint('api.x.ai', { [LAB_ENDPOINT_ENV]: 'not a url' }), /not a URL/);
  assert.throws(() => resolveLabEndpoint('api.x.ai', { [LAB_ENDPOINT_ENV]: 'ftp://127.0.0.1' }), /http:\/\/ or https:\/\//);
});
