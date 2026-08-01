import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as path from 'path';
import cookieParser from 'cookie-parser';
import { requireJwtSecret, corsAllowedOrigins } from './config/security.config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useStaticAssets(path.join(process.cwd(), '..', 'images'), {
    prefix: '/uploads',
  });
  // Fail fast rather than run with a forgeable signing key (7.7). With the
  // placeholder secret the app works perfectly — and every token, including an
  // admin one, can be minted by anyone who can read the repository.
  requireJwtSecret();

  // CORS (7.6). In development any origin is reflected, because LAN IPs and
  // shifting dev ports make an allowlist impractical there. In production an
  // explicit ALLOWED_ORIGINS list is REQUIRED: reflecting arbitrary origins
  // while credentials are enabled lets any site a signed-in user visits read
  // their authenticated responses. corsAllowedOrigins() throws if it is unset
  // in production, so this cannot be deployed open by accident.
  const allowed = corsAllowedOrigins();
  app.enableCors({
    origin: (origin, callback) => {
      if (allowed === null) return callback(null, true); // development
      // Same-origin and non-browser callers send no Origin header.
      if (!origin) return callback(null, true);
      if (allowed.includes(origin)) return callback(null, true);
      return callback(
        new Error(`Origin not allowed by CORS: ${origin}`),
        false,
      );
    },
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Accept, Authorization',
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.use(cookieParser());
  await app.listen(process.env.PORT ?? 4000, '0.0.0.0');
}
bootstrap().catch((err) => {
  console.error('Error during application startup:', err);
});
