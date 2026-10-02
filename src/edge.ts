/**
 * Edge-runtime stand-in for the main entry. Bundlers pick this file (package.json "exports" conditions
 * edge-light / worker / workerd / browser) when code is bundled for an edge runtime such as Next.js middleware,
 * where Node-only modules (node:crypto, AsyncLocalStorage) do not exist. Telemetry is Node-side only, so every
 * call here is a harmless no-op and importing the SDK from edge code can never break a request.
 */
export const DEFAULT_IGNORED_ERRORS: RegExp[] = [];

export function identify(): void {}
export function addBreadcrumb(): void {}
export function currentTrace(): undefined {
  return undefined;
}
export function startJobSpan(): undefined {
  return undefined;
}
export function injectTraceparent(headers: Record<string, string>): Record<string, string> {
  return headers;
}
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return headers;
}
export function sanitizeString(value: string): string {
  return value;
}

const noopSpan = { setTag() { return noopSpan; }, end() {} };

export class BeaconSDK {
  constructor(_config?: unknown) {}
  startSpan() { return noopSpan; }
  isIgnoredError(): boolean { return false; }
  captureException(): void {}
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
