import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';

// Load .env in development (Node 22 built-in, no dotenv package needed).
if (existsSync('.env')) process.loadEnvFile('.env');

export async function createApp() {
  // rawBody: true keeps the exact request bytes, needed to verify payment webhook signatures.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: process.env.NODE_ENV === 'test' ? ['error'] : undefined,
  });
  const config = app.get(AppConfig);

  app.setGlobalPrefix('api/v1');
  app.set('trust proxy', 1); // behind Caddy / Cloudflare: use the real client IP for rate limiting
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip properties that are not in the DTO
      forbidNonWhitelisted: true, // ...and reject requests that send them
      transform: true, // convert query strings to numbers/booleans as declared
    }),
  );
  app.enableShutdownHooks();
  return app;
}

if (process.env.NODE_ENV !== 'test') {
  const app = await createApp();
  const config = app.get(AppConfig);
  await app.listen(config.port);
  new Logger('Bootstrap').log(`API listening on ${config.publicApiUrl}/api/v1`);
}
