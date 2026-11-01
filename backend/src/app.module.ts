import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { SpectreService } from './spectre.service';
import { ScopeContext, SupabaseStore } from './store';
import { AuthService, IdentityMiddleware } from './auth.service';
import { ReminderService } from './reminder.service';
import { SupabaseService } from './supabase.service';
import { NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';

@Module({
  controllers: [AppController],
  providers: [ScopeContext, AuthService, IdentityMiddleware, ReminderService, SpectreService, SupabaseStore, SupabaseService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(IdentityMiddleware).forRoutes({ path: 'api/{*splat}', method: RequestMethod.ALL }); }
}
