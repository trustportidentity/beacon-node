import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface BeaconConfig {
  ingestUrl?: string;
  apiKey: string;
  serviceName: string;
  environment?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Redacts additional sensitive string patterns like obvious credit-card-like strings. */
  sanitizePii?: boolean;
  /**
   * Fraction of requests actually traced and sent to Beacon, from 0 (none) to 1 (all,
   * the default). Lower it in high-traffic services to control ingest volume and stay
   * within your plan's monthly quota - e.g. 0.1 traces ~10% of requests. Exceptions are
   * always sent regardless of this setting. A value outside (0, 1] is treated as 1.
   */
  sampleRate?: number;
}

export interface BeaconUser {
  id?: string;
  email?: string;
  username?: string;
  ip?: string;
}

export interface BeaconException {
  type: string;
  message: string;
  handled: boolean;
  stacktrace?: { file: string; line: number; function: string }[];
}

export interface BeaconRequestContext {
  method: string;
  route: string;
  url: string;
  status_code: number;
  headers?: Record<string, string>;
  client_ip?: string;
}

export interface BeaconSpanData {
  span_id?: string;
  parent_span_id?: string;
  type: 'database' | 'cache' | 'http' | 'job' | 'middleware' | 'custom';
  name: string;
  start_ms: number;
  duration_ms: number;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface BeaconBreadcrumb {
  category: 'log' | 'http' | 'query' | 'navigation' | 'ui' | 'user' | 'error' | string;
  message: string;
  level?: 'info' | 'warning' | 'error' | 'debug';
  timestamp?: string;
  data?: Record<string, unknown>;
}

export interface TraceEvent {
  id: string;
  project_key: string;
  service_name: string;
  environment: string;
  runtime: string;
  trace_id: string;
  parent_span?: string;
  timestamp: string;
  duration_ms: number;
  user?: BeaconUser | null;
  request?: BeaconRequestContext;
  spans: BeaconSpanData[];
  breadcrumbs?: BeaconBreadcrumb[];
  has_exception: boolean;
  exception?: BeaconException;
}

const ALWAYS_SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'proxy-authorization',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'token',
  'secret',
  'password',
]);

const CARD_NUMBER_RE = /\b(?:\d[ -]*?){13,19}\b/g;

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (
      ALWAYS_SENSITIVE_HEADERS.has(lower) ||
      lower.includes('token') ||
      lower.includes('secret') ||
      (lower.includes('key') && lower !== 'key')
    ) {
      out[k] = '[Filtered]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function sanitizeString(value: string): string {
  return value.replace(CARD_NUMBER_RE, '[redacted-card]');
}

export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

export interface ParsedTraceparent {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

export function parseTraceparent(header?: string | string[]): ParsedTraceparent | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  const trimmed = raw.trim();
  if (trimmed.length !== 55) return null;
  const parts = trimmed.split('-');
  if (parts.length !== 4) return null;
  if (parts[0].length !== 2 || parts[1].length !== 32 || parts[2].length !== 16 || parts[3].length !== 2) {
    return null;
  }
  if (!/^[0-9a-f]{32}$/i.test(parts[1]) || !/^[0-9a-f]{16}$/i.test(parts[2])) {
    return null;
  }
  if (parts[1] === '00000000000000000000000000000000' || parts[2] === '0000000000000000') {
    return null;
  }
  return {
    traceId: parts[1].toLowerCase(),
    parentSpanId: parts[2].toLowerCase(),
    sampled: parts[3] === '01',
  };
}

/** A single in-flight span. Call end() when the operation completes. */
export class Span {
  readonly spanId: string;
  readonly parentSpanId: string;
  private tags: Record<string, string> = {};
  private startedAt: number;

  constructor(
    private readonly trace: ActiveTrace,
    private readonly type: BeaconSpanData['type'],
    private readonly name: string,
    private readonly metadata?: Record<string, unknown>,
  ) {
    this.spanId = generateSpanId();
    this.parentSpanId = trace.spanId;
    this.startedAt = performance.now();
  }

  setTag(key: string, value: unknown): this {
    this.tags[key] = String(value);
    return this;
  }

  end(): void {
    const durationMs = performance.now() - this.startedAt;
    const startMs = this.startedAt - this.trace.startedAt;
    this.trace.spans.push({
      span_id: this.spanId,
      parent_span_id: this.parentSpanId,
      type: this.type,
      name: this.name,
      start_ms: Math.max(0, Math.round(startMs * 100) / 100),
      duration_ms: Math.round(durationMs * 100) / 100,
      metadata: this.metadata,
      tags: Object.keys(this.tags).length > 0 ? this.tags : undefined,
    });
  }
}

/** Per-request trace state, held alive for the request's lifetime via AsyncLocalStorage. */
export class ActiveTrace {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startedAt: number;
  readonly spans: BeaconSpanData[] = [];
  readonly breadcrumbs: BeaconBreadcrumb[] = [];
  user: BeaconUser | null = null;

  constructor(headerOrTraceId?: string) {
    const parsed = parseTraceparent(headerOrTraceId);
    if (parsed) {
      this.traceId = parsed.traceId;
      this.parentSpanId = parsed.parentSpanId;
    } else if (headerOrTraceId && headerOrTraceId.trim().length > 0) {
      this.traceId = headerOrTraceId.trim();
    } else {
      this.traceId = generateTraceId();
    }
    this.spanId = generateSpanId();
    this.startedAt = performance.now();
  }

  get traceparent(): string {
    return `00-${this.traceId}-${this.spanId}-01`;
  }

  identify(user: BeaconUser): void {
    this.user = user;
  }

  addBreadcrumb(crumb: BeaconBreadcrumb): void {
    this.breadcrumbs.push({
      ...crumb,
      timestamp: crumb.timestamp || new Date().toISOString(),
    });
    if (this.breadcrumbs.length > 100) {
      this.breadcrumbs.shift();
    }
  }

  startSpan(name: string, type: BeaconSpanData['type'] = 'custom', metadata?: Record<string, unknown>): Span {
    return new Span(this, type, name, metadata);
  }

  startJobSpan(jobName: string, queueName?: string, metadata?: Record<string, unknown>): Span {
    const meta = { ...metadata, ...(queueName ? { queue: queueName } : {}) };
    const span = new Span(this, 'job', `JOB ${jobName}`, meta);
    span.setTag('job', jobName);
    if (queueName) {
      span.setTag('queue', queueName);
    }
    return span;
  }
}

const traceStorage = new AsyncLocalStorage<ActiveTrace>();

/** Returns the active trace for the request currently being handled, if any. */
export function currentTrace(): ActiveTrace | undefined {
  return traceStorage.getStore();
}

/** Attaches a user identity to the request currently being handled. */
export function identify(user: BeaconUser): void {
  traceStorage.getStore()?.identify(user);
}

/** Records a breadcrumb into the currently active request trace. */
export function addBreadcrumb(crumb: BeaconBreadcrumb): void {
  traceStorage.getStore()?.addBreadcrumb(crumb);
}

/** Starts a background job or queue execution span in the currently active request trace. */
export function startJobSpan(jobName: string, queueName?: string, metadata?: Record<string, unknown>): Span | undefined {
  return traceStorage.getStore()?.startJobSpan(jobName, queueName, metadata);
}

/**
 * Core Beacon client. Framework-agnostic: batches and ships trace events to the
 * ingest endpoint. Use expressMiddleware() for Express, or the ./nestjs subpath
 * for NestJS.
 */
export class BeaconSDK {
  private readonly cfg: Required<Omit<BeaconConfig, 'sanitizePii'>> & Pick<BeaconConfig, 'sanitizePii'>;
  private queue: TraceEvent[] = [];
  private timer: ReturnType<typeof setInterval>;

  constructor(config: BeaconConfig) {
    const sampleRate = config.sampleRate ?? 1;
    this.cfg = {
      ingestUrl: config.ingestUrl || 'http://localhost:8443',
      apiKey: config.apiKey,
      serviceName: config.serviceName,
      environment: config.environment || 'production',
      batchSize: config.batchSize || 50,
      flushIntervalMs: config.flushIntervalMs || 1000,
      sampleRate: sampleRate > 0 && sampleRate <= 1 ? sampleRate : 1,
      sanitizePii: config.sanitizePii,
    };
    this.timer = setInterval(() => void this.flush(), this.cfg.flushIntervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Starts a span on the request currently being handled (via AsyncLocalStorage). */
  startSpan(name: string, type: BeaconSpanData['type'] = 'custom', metadata?: Record<string, unknown>): Span {
    const trace = traceStorage.getStore() || new ActiveTrace();
    return trace.startSpan(name, type, metadata);
  }

  /**
   * Exceptions are always sent regardless of sampleRate - sampling controls ingest volume
   * for routine traffic, never error visibility.
   */
  private shouldSample(hasException: boolean): boolean {
    if (hasException || this.cfg.sampleRate >= 1) return true;
    return Math.random() < this.cfg.sampleRate;
  }

  private report(trace: ActiveTrace, request: BeaconRequestContext, durationMs: number, exception?: BeaconException): void {
    if (!this.shouldSample(!!exception)) return;

    const sanitizedRequest: BeaconRequestContext = { ...request };
    if (sanitizedRequest.headers) {
      sanitizedRequest.headers = sanitizeHeaders(sanitizedRequest.headers);
    }
    if (this.cfg.sanitizePii) {
      sanitizedRequest.url = sanitizeString(sanitizedRequest.url);
    }

    const event: TraceEvent = {
      id: trace.traceId,
      project_key: this.cfg.apiKey,
      service_name: this.cfg.serviceName,
      environment: this.cfg.environment,
      runtime: `node${process.version}`,
      trace_id: trace.traceId,
      parent_span: trace.parentSpanId,
      timestamp: new Date().toISOString(),
      duration_ms: Math.round(durationMs * 100) / 100,
      user: trace.user,
      request: sanitizedRequest,
      spans: trace.spans,
      breadcrumbs: trace.breadcrumbs,
      has_exception: !!exception,
      exception,
    };

    this.queue.push(event);
    if (this.queue.length >= this.cfg.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];

    try {
      await fetch(`${this.cfg.ingestUrl}/v1/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Beacon-Key': this.cfg.apiKey,
        },
        body: JSON.stringify(batch),
      });
    } catch {
      // Non-blocking telemetry failure — never take the host app down over this.
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  /**
   * Express middleware: runs each request inside an AsyncLocalStorage context so
   * startSpan()/identify() work without needing the request object, then reports
   * the finished trace on response finish.
   */
  expressMiddleware() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const sdk = this;
    return function beaconExpressMiddleware(req: any, res: any, next: () => void) {
      const trace = new ActiveTrace(req.headers?.['traceparent']);
      if (typeof res.setHeader === 'function') {
        res.setHeader('traceparent', trace.traceparent);
      }
      const start = performance.now();

      res.on('finish', () => {
        const durationMs = performance.now() - start;
        sdk['report'](
          trace,
          {
            method: req.method,
            route: (req.route && req.route.path) || req.path || req.url,
            url: req.originalUrl || req.url,
            status_code: res.statusCode,
            headers: flattenHeaders(req.headers),
            client_ip: req.ip || req.headers?.['x-forwarded-for'],
          },
          durationMs,
          res.statusCode >= 500
            ? { type: 'HandlerError', message: `Request failed with status ${res.statusCode}`, handled: true }
            : undefined,
        );
      });

      traceStorage.run(trace, next);
    };
  }

  /** Used internally by adapters (e.g. the NestJS interceptor) to report a finished trace. */
  reportTrace(trace: ActiveTrace, request: BeaconRequestContext, durationMs: number, exception?: BeaconException): void {
    this.report(trace, request, durationMs, exception);
  }

  runWithTrace<T>(trace: ActiveTrace, fn: () => T): T {
    return traceStorage.run(trace, fn);
  }
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v[0];
  }
  return out;
}

export function injectTraceparent(headers: Record<string, string>, trace?: ActiveTrace): Record<string, string> {
  const active = trace || currentTrace();
  if (active) {
    headers['traceparent'] = active.traceparent;
  }
  return headers;
}
