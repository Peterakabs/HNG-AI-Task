import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: process.env.WEB_ORIGIN || 'http://localhost:5173', credentials: true });
  app.setGlobalPrefix('');
  await app.listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
bootstrap();
