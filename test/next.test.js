const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { initBeacon, getBeacon, withBeacon, onRequestError } = require('../dist/next.js');
const { identify, currentTrace, addBreadcrumb } = require('../dist/index.js');

const SDK_KEY = Symbol.for('trustportidentity.beacon.sdk');
const resetSdk = () => { globalThis[SDK_KEY] = undefined; };

function startIngest() {
  const batches = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      batches.push({ key: req.headers['x-beacon-key'], events: JSON.parse(body) });
      res.writeHead(202).end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, batches, url: `http://127.0.0.1:${server.address().port}` })));
}

test('withBeacon is a transparent passthrough when Beacon is not initialised', async () => {
  resetSdk();
  initBeacon({ apiKey: '', serviceName: 'x' });
  assert.equal(getBeacon(), null);
  const res = await withBeacon(async () => new Response('hi', { status: 201 }))(new Request('http://a.test/x'), {});
  assert.equal(res.status, 201);
  assert.equal(await res.text(), 'hi');
});

test('withBeacon reports user, spans, breadcrumbs, status and errors', async () => {
  const { server, batches, url } = await startIngest();
  resetSdk();
  const sdk = initBeacon({ apiKey: 'tb_live_test', ingestUrl: url, serviceName: 'eirs-mail', environment: 'production' });
  assert.ok(sdk);

  const ok = withBeacon(
    async (req, ctx) => {
      identify({ id: 'u1', email: 'a@b.ng' });
      addBreadcrumb({ category: 'user', message: 'listed inbox', level: 'info' });
      const span = sdk.startSpan('db.findMany', 'database', { table: 'Message' });
      span.end();
      assert.ok(currentTrace(), 'trace must be active inside the handler');
      assert.equal(ctx.params.id, '7');
      return Response.json({ ok: true });
    },
    { route: '/api/messages/[id]' },
  );
  const r1 = await ok(new Request('http://mail.test/api/messages/7?folder=INBOX', { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', authorization: 'Bearer secret' } }), { params: { id: '7' } });
  assert.equal(r1.status, 200);

  const fail = withBeacon(async () => new Response('nope', { status: 503 }), { route: '/api/send' });
  assert.equal((await fail(new Request('http://mail.test/api/send', { method: 'POST' }), {})).status, 503);

  const boom = withBeacon(async () => { throw new TypeError('kaput'); }, { route: '/api/boom' });
  await assert.rejects(() => boom(new Request('http://mail.test/api/boom'), {}), /kaput/);

  await onRequestError(new Error('render failed'), { path: '/mail', method: 'GET', headers: { host: 'x' } }, { routePath: '/mail' });

  await sdk.flush();
  const events = batches.flatMap((b) => b.events);
  assert.equal(events.length, 4);
  assert.ok(batches.every((b) => b.key === 'tb_live_test'));

  const e1 = events.find((e) => e.request.route === '/api/messages/[id]');
  assert.equal(e1.request.status_code, 200);
  assert.equal(e1.request.url, '/api/messages/7?folder=INBOX');
  assert.equal(e1.request.client_ip, '1.2.3.4');
  assert.notEqual(e1.request.headers.authorization, 'Bearer secret', 'auth header must be redacted');
  assert.deepEqual({ id: e1.user.id, email: e1.user.email }, { id: 'u1', email: 'a@b.ng' });
  assert.equal(e1.spans.length, 1);
  assert.equal(e1.spans[0].type, 'database');
  assert.equal(e1.breadcrumbs.length, 1);
  assert.equal(e1.has_exception, false);

  const e2 = events.find((e) => e.request.route === '/api/send');
  assert.equal(e2.request.status_code, 503);
  assert.equal(e2.has_exception, true);

  const e3 = events.find((e) => e.request.route === '/api/boom');
  assert.equal(e3.request.status_code, 500);
  assert.equal(e3.exception.type, 'TypeError');
  assert.equal(e3.exception.handled, false);

  const e4 = events.find((e) => e.request.route === '/mail');
  assert.equal(e4.exception.message, 'render failed');

  await sdk.close();
  server.close();
});

test('identify() works across two loaded copies of the SDK (bundlers load it twice)', async () => {
  const { server, batches, url } = await startIngest();
  resetSdk();
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  // Copy A (the real dist) creates the SDK and runs the request; copy B is the same code loaded
  // as a separate module instance, like a second bundle. B's identify() must still reach A's trace.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-copy-')), 'index.js');
  fs.copyFileSync(path.join(__dirname, '../dist/index.js'), tmp);
  const copyB = require(tmp);
  assert.notEqual(copyB.identify, require('../dist/index.js').identify, 'must be a distinct module instance');
  const sdk = initBeacon({ apiKey: 'tb_live_dup', ingestUrl: url, serviceName: 'dup' });
  await withBeacon(async () => {
    copyB.identify({ id: 'cross', email: 'cross@copy.ng' });
    copyB.addBreadcrumb({ category: 'user', message: 'from copy B' });
    return new Response('ok');
  }, { route: '/dup' })(new Request('http://x.test/dup'), {});
  await sdk.flush();
  const ev = batches.flatMap((b) => b.events).find((e) => e.request.route === '/dup');
  assert.equal(ev.user.email, 'cross@copy.ng');
  assert.equal(ev.breadcrumbs.length, 1);
  await sdk.close();
  server.close();
});

test('an error reported by withBeacon is not reported again by onRequestError', async () => {
  const { server, batches, url } = await startIngest();
  resetSdk();
  const sdk = initBeacon({ apiKey: 'tb_live_once', ingestUrl: url, serviceName: 'once' });
  const err = new Error('once only');
  await assert.rejects(() => withBeacon(async () => { throw err; }, { route: '/once' })(new Request('http://x.test/once'), {}));
  // Next passes the hook a different Error instance with the same message.
  await onRequestError(new Error('once only'), { path: '/once', method: 'GET', headers: {} }, { routePath: '/once' });
  // A genuinely different error on the same route must still be reported.
  await onRequestError(new Error('a different failure'), { path: '/once', method: 'GET', headers: {} }, { routePath: '/once' });
  await sdk.flush();
  const once = batches.flatMap((b) => b.events).filter((e) => e.request.route === '/once');
  assert.equal(once.length, 2);
  assert.deepEqual(once.map((e) => e.exception.message).sort(), ['a different failure', 'once only']);
  await sdk.close();
  server.close();
});

test('error dedupe works across two loaded copies of the adapter (separate bundles)', async () => {
  const { server, batches, url } = await startIngest();
  resetSdk();
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-copy2-'));
  for (const f of ['index.js', 'next.js']) fs.copyFileSync(path.join(__dirname, '../dist', f), path.join(dir, f));
  const copyB = require(path.join(dir, 'next.js')); // a second, independent copy of the adapter
  const sdk = initBeacon({ apiKey: 'tb_live_x', ingestUrl: url, serviceName: 'x' });
  await assert.rejects(() => withBeacon(async () => { throw new Error('same failure'); }, { route: '/x' })(new Request('http://x.test/x'), {}));
  await copyB.onRequestError(new Error('same failure'), { path: '/x', method: 'GET', headers: {} }, { routePath: '/x' });
  await sdk.flush();
  assert.equal(batches.flatMap((b) => b.events).filter((e) => e.request.route === '/x').length, 1);
  await sdk.close();
  server.close();
});
