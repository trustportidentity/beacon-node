/** Edge-runtime stand-in for "@trusportidentity/beacon-node/next": everything is a no-op (see edge.ts). */
export function initBeacon(): null {
  return null;
}
export function getBeacon(): null {
  return null;
}
export function captureException(): void {}
export function withBeacon<H>(handler: H): H {
  return handler;
}
export async function onRequestError(): Promise<void> {}
