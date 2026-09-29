const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ActiveTrace,
  parseTraceparent,
  generateTraceId,
  generateSpanId,
  sanitizeHeaders,
  injectTraceparent,
} = require('../dist/index.js');

test('W3C traceparent parsing with valid header', () => {
  const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const parsed = parseTraceparent(header);

  assert.ok(parsed, 'should parse valid traceparent');
  assert.equal(parsed.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(parsed.parentSpanId, '00f067aa0ba902b7');
  assert.equal(parsed.sampled, true);
});

test('W3C traceparent parsing with invalid headers', () => {
  assert.equal(parseTraceparent(''), null);
  assert.equal(parseTraceparent('invalid-header'), null);
  assert.equal(parseTraceparent('00-00000000000000000000000000000000-0000000000000000-00'), null);
});

test('ActiveTrace propagates traceId and generates new spanId', () => {
  const incoming = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const trace = new ActiveTrace(incoming);

  assert.equal(trace.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(trace.parentSpanId, '00f067aa0ba902b7');
  assert.match(trace.spanId, /^[0-9a-f]{16}$/);
  assert.equal(trace.traceparent, `00-4bf92f3577b34da6a3ce929d0e0e4736-${trace.spanId}-01`);
});

test('ActiveTrace generates fresh IDs when no header is supplied', () => {
  const trace = new ActiveTrace();
  assert.match(trace.traceId, /^[0-9a-f]{32}$/);
  assert.match(trace.spanId, /^[0-9a-f]{16}$/);
  assert.equal(trace.parentSpanId, undefined);
});

test('Span hierarchy assigns parent_span_id to child spans', () => {
  const trace = new ActiveTrace();
  const span = trace.startSpan('db_query', 'database', { query: 'SELECT 1' });
  span.setTag('engine', 'postgres');
  span.end();

  assert.equal(trace.spans.length, 1);
  const recorded = trace.spans[0];
  assert.equal(recorded.name, 'db_query');
  assert.equal(recorded.type, 'database');
  assert.match(recorded.span_id, /^[0-9a-f]{16}$/);
  assert.equal(recorded.parent_span_id, trace.spanId);
  assert.equal(recorded.tags.engine, 'postgres');
});

test('SanitizeHeaders redacts sensitive headers', () => {
  const raw = {
    authorization: 'Bearer token-12345',
    'x-api-key': 'secret-key-999',
    cookie: 'session=xyz',
    'x-custom-header': 'safe-value',
  };

  const sanitized = sanitizeHeaders(raw);
  assert.equal(sanitized.authorization, '[Filtered]');
  assert.equal(sanitized['x-api-key'], '[Filtered]');
  assert.equal(sanitized.cookie, '[Filtered]');
  assert.equal(sanitized['x-custom-header'], 'safe-value');
});

test('injectTraceparent sets traceparent header', () => {
  const trace = new ActiveTrace();
  const headers = {};
  injectTraceparent(headers, trace);

  assert.equal(headers.traceparent, trace.traceparent);
});

test('ActiveTrace captures breadcrumbs with bounding', () => {
  const trace = new ActiveTrace();
  trace.addBreadcrumb({
    category: 'log',
    message: 'User entered checkout step 1',
    level: 'info',
  });
  trace.addBreadcrumb({
    category: 'query',
    message: 'SELECT * FROM carts WHERE user_id = 99',
    level: 'info',
    data: { duration_ms: 2.1 },
  });

  assert.equal(trace.breadcrumbs.length, 2);
  assert.equal(trace.breadcrumbs[0].category, 'log');
  assert.equal(trace.breadcrumbs[1].category, 'query');
  assert.ok(trace.breadcrumbs[0].timestamp);
});

test('startJobSpan captures background queue and job attributes', () => {
  const trace = new ActiveTrace();
  const span = trace.startJobSpan('GenerateInvoicePDF', 'billing-queue', {
    invoice_id: 'inv_123',
    attempts: 1,
  });
  span.end();

  assert.equal(trace.spans.length, 1);
  const s = trace.spans[0];
  assert.equal(s.type, 'job');
  assert.equal(s.name, 'JOB GenerateInvoicePDF');
  assert.equal(s.metadata.queue, 'billing-queue');
  assert.equal(s.metadata.invoice_id, 'inv_123');
  assert.equal(s.tags.job, 'GenerateInvoicePDF');
  assert.equal(s.tags.queue, 'billing-queue');
});

