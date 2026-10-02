# @trusportidentity/beacon-node

Official TrustPort Beacon APM SDK for Node.js, Express, and NestJS.

## Install

```bash
npm install @trusportidentity/beacon-node
```

## Express

```ts
import express from 'express';
import { BeaconSDK } from '@trusportidentity/beacon-node';

const app = express();
const beacon = new BeaconSDK({
  ingestUrl: 'https://beacon-api.trustportidentity.com',
  apiKey: process.env.BEACON_API_KEY!,
  serviceName: 'billing-api',
  environment: 'production',
});

app.use(beacon.expressMiddleware());

app.get('/api/v1/invoices', async (req, res) => {
  const span = beacon.startSpan('db.prisma.findMany_invoices');
  span.setTag('tenant_id', req.headers['x-tenant-id']);
  span.end();
  res.json({ success: true });
});
```

## NestJS

```ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BeaconInterceptor, BeaconModule } from '@trusportidentity/beacon-node/nestjs';

@Module({
  imports: [
    BeaconModule.forRoot({
      ingestUrl: process.env.BEACON_INGEST_URL,
      apiKey: process.env.BEACON_API_KEY,
      serviceName: 'user-service',
    }),
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: BeaconInterceptor }],
})
export class AppModule {}
```

## Handled errors and noise (v1.1)

Errors you catch and handle never reach Beacon on their own. Report the ones that matter:

```ts
import { captureException } from '@trusportidentity/beacon-node/next';

try {
  await prisma.contact.create({ data });
} catch (err) {
  captureException(err, { route: '/api/messages', tags: { feature: 'contacts' } }); // shows up as a handled issue
}
```

Framework noise is ignored for you: Next.js's `Failed to find Server Action` (a browser holding a page from before a
deploy) is dropped by default. Add your own with `ignoreErrors` (substring or RegExp):

```ts
initBeacon({ /* ... */ ignoreErrors: ['ECONNRESET', /^AbortError/] });
```

## Controlling ingest volume

Every trace is already batched (`batchSize`/`flushIntervalMs`) instead of one network call
per request. In high-traffic services, also set `sampleRate` (0–1, default 1) to trace only
a fraction of requests — this is what actually keeps you inside your plan's monthly quota.
Exceptions are always sent regardless of sampling.

```ts
const beacon = new BeaconSDK({
  // ...
  sampleRate: 0.2, // trace ~20% of requests
});
```

See the full guide at [beacon.trustportidentity.com/help/node](https://beacon.trustportidentity.com/help/node).

## Next.js (App Router)

Server runtime only (Node). Wrap route handlers; `identify()`, `startSpan()` and `addBreadcrumb()` work inside them without passing the request around. Everything is a no-op when no API key is configured, so wrapping is safe in every environment.

```ts
// instrumentation.ts (project root)
export { onRequestError } from '@trusportidentity/beacon-node/next';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initBeacon } = await import('@trusportidentity/beacon-node/next');
    initBeacon({
      apiKey: process.env.BEACON_API_KEY ?? '',
      ingestUrl: process.env.BEACON_ENDPOINT ?? 'https://beacon-api.trustportidentity.com',
      serviceName: 'my-app',
      environment: process.env.BEACON_ENVIRONMENT ?? 'production',
      sampleRate: Number(process.env.BEACON_SAMPLE_RATE) || 1,
    });
  }
}
```

```ts
// app/api/things/route.ts
import { withBeacon } from '@trusportidentity/beacon-node/next';
import { identify } from '@trusportidentity/beacon-node';

export const GET = withBeacon(async (req) => {
  identify({ id: user.id, email: user.email }); // after you authenticate
  return Response.json({ ok: true });
}, { route: '/api/things' });
```

`onRequestError` reports errors thrown while rendering server components or in handlers that are not wrapped. Middleware runs on the Edge runtime and is not instrumented.

Install straight from GitHub until the package is published: `npm i github:trustportidentity/beacon-node#<commit>`.
