import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDiagnostics, responseDiagnostics } from '../server/diagnostics.js';
import { createPublicFetcher } from '../server/fetch.js';

test('403 diagnostics correlate redirects and capture failure without logging secrets', async t => {
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(JSON.parse(line)));
  let destroyed = 0;
  class Dispatcher { async destroy() { destroyed++; } }
  const fetcher = createPublicFetcher({Dispatcher, resolveHost: async () => [{address:'1.1.1.1', family:4}], request: async url => url.includes('/start')
    ? new Response('', {status:302, headers:{location:'/blocked?token=redirect-secret'}})
    : new Response('<title>Just a moment</title>cf-chl- private-body-secret', {status:403, headers:{server:'cloudflare', 'cf-ray':'ray-id', 'cf-mitigated':'challenge', 'set-cookie':'cookie-secret'}})});
  await assert.rejects(captureDiagnostics('https://example.com/start?token=input-secret', () => fetcher('https://example.com/start?token=input-secret')), /HTTP 403/);
  assert.deepEqual(lines.map(l => l.event), ['capture.started', 'fetch.http_error', 'capture.failed']);
  assert.ok(lines.every(l => l.captureId === lines[0].captureId));
  assert.equal(lines[1].status, 403);
  assert.deepEqual(lines[1].hops.map(h => h.status), [302,403]);
  assert.equal(lines[1].headers['cf-ray'], 'ray-id');
  assert.ok(lines[1].markers.includes('cloudflareChallenge'));
  assert.doesNotMatch(JSON.stringify(lines), /input-secret|redirect-secret|cookie-secret|private-body-secret/);
  assert.equal(destroyed, 2);
});

test('diagnostic reads are bounded and cancel oversized or stalled response bodies', async () => {
  let cancelled = false;
  const result = await responseDiagnostics(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('Access denied ' + 'x'.repeat(20000))); },
    cancel() { cancelled = true; },
  })));
  assert.equal(result.inspectedBytes, 16384);
  assert.deepEqual(result.markers, ['accessDenied']);
  assert.ok(cancelled);
  cancelled = false;
  const stalled = await responseDiagnostics(new Response(new ReadableStream({cancel() { cancelled = true; }})));
  assert.equal(stalled.diagnosticReadError, true);
  assert.ok(cancelled);
});

test('network errors retain diagnostic code and original rejection', async t => {
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(JSON.parse(line)));
  const error = new Error('contains-secret', {cause:{code:'ENOTFOUND'}});
  const fetcher = createPublicFetcher({resolveHost: async () => { throw error; }});
  await assert.rejects(fetcher('https://example.com/?secret=value'), e => e === error);
  assert.equal(lines[0].code, 'ENOTFOUND');
  assert.doesNotMatch(JSON.stringify(lines), /contains-secret|secret=value/);
});
