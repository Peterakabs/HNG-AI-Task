import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { SpectreService } from './spectre.service';
import { JsonStore } from './store';

@Module({
  controllers: [AppController],
  providers: [SpectreService, JsonStore, { provide: 'SPECTRE_DATA_FILE', useFactory: () => process.env.SPECTRE_DATA_FILE }],
})
export class AppModule {}
