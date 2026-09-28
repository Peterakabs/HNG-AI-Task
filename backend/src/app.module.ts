import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { SpectreService } from './spectre.service';
import { JsonStore } from './store';
import { ScopeContext } from './store';
import { AuthService, IdentityMiddleware } from './auth.service';
import { ReminderService } from './reminder.service';
import { NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';

@Module({
  controllers: [AppController],
  providers: [ScopeContext, AuthService, IdentityMiddleware, ReminderService, SpectreService, JsonStore, { provide: 'SPECTRE_DATA_FILE', useFactory: () => process.env.SPECTRE_DATA_FILE }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(IdentityMiddleware).forRoutes({ path: 'api/{*splat}', method: RequestMethod.ALL }); }
}
