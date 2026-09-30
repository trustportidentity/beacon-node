const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { initBeacon, getBeacon, withBeacon, onRequestError } = require('../dist/next.js');
const { identify, currentTrace, addBreadcrumb } = require('../dist/index.js');

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
  initBeacon({ apiKey: '', serviceName: 'x' });
  assert.equal(getBeacon(), null);
  const res = await withBeacon(async () => new Response('hi', { status: 201 }))(new Request('http://a.test/x'), {});
  assert.equal(res.status, 201);
  assert.equal(await res.text(), 'hi');
});

test('withBeacon reports user, spans, breadcrumbs, status and errors', async () => {
  const { server, batches, url } = await startIngest();
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
