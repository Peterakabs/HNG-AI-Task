import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuthService } from './auth.service';

@Injectable()
export class ReminderService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly auth: AuthService) {}
  onModuleInit() {
    this.timer = setInterval(() => { void this.runDue(); }, 15_000);
    this.timer.unref();
    void this.runDue();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async runDue() {
    if (this.running) return;
    this.running = true;
    try {
      for (const action of this.auth.claimDueActions()) {
        const appName = process.env.APP_NAME || 'Spectre';
        const baseUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
        const body = `Hi ${action.recipientName},\n\nThis is a reminder from ${appName} to ${action.message}.\n\nView task: ${baseUrl}\n`;
        try { await this.auth.sendEmail(action.recipientEmail, action.subject || `Reminder: ${action.message}`, body); this.auth.finishAction(action.id); }
        catch (error) { this.auth.finishAction(action.id, error instanceof Error ? error.message : 'Email delivery failed.'); }
      }
    } finally { this.running = false; }
  }
}
