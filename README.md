# @trustportidentity/beacon-node

Official TrustPort Beacon APM SDK for Node.js, Express, and NestJS.

## Install

```bash
npm install @trustportidentity/beacon-node
```

## Express

```ts
import express from 'express';
import { BeaconSDK } from '@trustportidentity/beacon-node';

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
import { BeaconInterceptor, BeaconModule } from '@trustportidentity/beacon-node/nestjs';

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

See the full guide at [beacon.trustportidentity.com/help/node](https://beacon.trustportidentity.com/help/node).
