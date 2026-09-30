/**
 * Next.js adapter (App Router route handlers, server runtime).
 *
 *   // instrumentation.ts
 *   export { onRequestError } from '@trusportidentity/beacon-node/next';
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === 'nodejs') {
 *       const { initBeacon } = await import('@trusportidentity/beacon-node/next');
 *       initBeacon({ apiKey: process.env.BEACON_API_KEY!, ingestUrl: process.env.BEACON_ENDPOINT, serviceName: 'my-app' });
 *     }
 *   }
 *
 *   // app/api/things/route.ts
 *   import { withBeacon } from '@trusportidentity/beacon-node/next';
 *   export const GET = withBeacon(async (req) => Response.json({ ok: true }), { route: '/api/things' });
 *
 * Inside a wrapped handler, identify(), startSpan() and addBreadcrumb() from the main entry
 * work without passing the request around. Everything is a no-op when Beacon is not initialised
 * (no API key), so it is safe to wrap handlers unconditionally.
 */
import { ActiveTrace, BeaconConfig, BeaconException, BeaconSDK } from './index';

const GLOBAL_KEY = Symbol.for('trustportidentity.beacon.sdk');
type Holder = { [GLOBAL_KEY]?: BeaconSDK | null };

/** Creates the process-wide SDK once (survives dev hot reloads). Returns null without an API key. */
export function initBeacon(config: BeaconConfig): BeaconSDK | null {
  const g = globalThis as unknown as Holder;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as BeaconSDK;
  if (!config.apiKey) {
    g[GLOBAL_KEY] = null;
    return null;
  }
  g[GLOBAL_KEY] = new BeaconSDK(config);
  return g[GLOBAL_KEY] as BeaconSDK;
}

export function getBeacon(): BeaconSDK | null {
  return (globalThis as unknown as Holder)[GLOBAL_KEY] ?? null;
}

// Next.js passes onRequestError a different error object than the one a wrapped handler threw,
// so identity can't dedupe. Instead remember (path, message) for a few seconds: an error that
// withBeacon already reported is not reported a second time by the framework hook.
const RECENT_ERROR_TTL_MS = 10_000;
// Process-wide (not module-level): the framework hook and the wrapper can live in different bundles.
const RECENT_KEY = Symbol.for('trustportidentity.beacon.recent-errors');
const recentHolder = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
const recentErrors: Map<string, number> = (recentHolder[RECENT_KEY] ??= new Map<string, number>());

function errorKey(path: string, message: string): string {
  return `${path}\u0000${message}`;
}

function rememberError(paths: string[], message: string): void {
  const now = Date.now();
  for (const [k, at] of recentErrors) if (now - at > RECENT_ERROR_TTL_MS) recentErrors.delete(k);
  for (const p of paths) recentErrors.set(errorKey(p, message), now);
}

function alreadyReported(paths: string[], message: string): boolean {
  const now = Date.now();
  return paths.some((p) => {
    const at = recentErrors.get(errorKey(p, message));
    return at !== undefined && now - at <= RECENT_ERROR_TTL_MS;
  });
}

type RouteHandler<C> = (req: Request, ctx: C) => Promise<Response> | Response;

export interface WithBeaconOptions {
  /** The route pattern, e.g. "/api/messages/[id]". Defaults to the request path. */
  route?: string;
}

function headersOf(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function clientIp(h: Headers): string | undefined {
  const fwd = h.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0].trim() : h.get('x-real-ip')) || undefined;
}

/** Wraps an App Router route handler so each request becomes a Beacon trace. */
export function withBeacon<C = unknown>(handler: RouteHandler<C>, options: WithBeaconOptions = {}): RouteHandler<C> {
  return async (req: Request, ctx: C): Promise<Response> => {
    const sdk = getBeacon();
    if (!sdk) return handler(req, ctx);

    const start = performance.now();
    const trace = new ActiveTrace(req.headers.get('traceparent') ?? undefined);
    const url = new URL(req.url);
    const request = {
      method: req.method,
      route: options.route || url.pathname,
      url: url.pathname + url.search,
      headers: headersOf(req.headers),
      client_ip: clientIp(req.headers),
    };

    let res: Response;
    try {
      res = await sdk.runWithTrace(trace, () => Promise.resolve(handler(req, ctx)));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      rememberError([options.route || url.pathname, url.pathname], e.message);
      sdk.reportTrace(trace, { ...request, status_code: 500 }, performance.now() - start, {
        type: e.name || 'Error',
        message: e.message,
        handled: false,
        stacktrace: [],
      });
      throw err;
    }

    const exception: BeaconException | undefined =
      res.status >= 500 ? { type: 'HandlerError', message: `Request failed with status ${res.status}`, handled: true } : undefined;
    sdk.reportTrace(trace, { ...request, status_code: res.status }, performance.now() - start, exception);
    return res;
  };
}

/**
 * Next.js `onRequestError` hook (instrumentation.ts): reports errors thrown while rendering
 * server components or running route handlers that the wrapper did not see.
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routePath?: string; routeType?: string } = {},
): Promise<void> {
  const sdk = getBeacon();
  if (!sdk) return;
  const e = err instanceof Error ? err : new Error(String(err));
  if (alreadyReported([context.routePath || '', request.path], e.message)) return;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers || {})) {
    if (typeof v === 'string') headers[k] = v;
    else if (Array.isArray(v) && v.length) headers[k] = v[0];
  }
  sdk.reportTrace(
    new ActiveTrace(headers['traceparent']),
    {
      method: request.method,
      route: context.routePath || request.path,
      url: request.path,
      status_code: 500,
      headers,
    },
    0,
    { type: e.name || 'Error', message: e.message, handled: false, stacktrace: [] },
  );
}
