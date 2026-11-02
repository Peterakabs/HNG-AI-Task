import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const backendEnv = resolve(__dirname, '../.env');
if (existsSync(backendEnv)) process.loadEnvFile(backendEnv);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.enableCors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173', credentials: true });
  app.setGlobalPrefix('');
  await app.listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
bootstrap();
