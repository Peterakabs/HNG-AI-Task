import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuthService } from './auth.service';

@Injectable()
export class ReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReminderService.name);
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
      try { await this.auth.processDueTaskNotifications(); }
      catch (error) { this.logger.error('Could not process task notifications; scheduled email reminders will continue.', error instanceof Error ? error.stack : String(error)); }
      for (const action of await this.auth.claimDueActions()) {
        const appName = process.env.APP_NAME || 'Spectre';
        try {
          const reminderUrl = await this.auth.createGuestReminderLink(action.id, action.scheduledAt);
          const body = `Hi ${action.recipientName},\n\nThis is a reminder from ${appName} to ${action.message}.\n\nView Reminder: ${reminderUrl}\n`;
          const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
          const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:32px auto;padding:24px;color:#171923;border:1px solid #e5e7eb;border-radius:16px"><p>Hi ${escapeHtml(action.recipientName)},</p><p>This is a reminder from ${escapeHtml(appName)}:</p><p style="font-size:18px;line-height:1.6">${escapeHtml(action.message)}</p><p style="margin:28px 0"><a href="${escapeHtml(reminderUrl)}" style="display:inline-block;padding:12px 20px;background:#315be8;color:white;text-decoration:none;border-radius:8px;font-weight:700">View Reminder</a></p><p style="font-size:12px;color:#6b7280">You can view and acknowledge this reminder without creating an account.</p></div>`;
          await this.auth.sendEmail(action.recipientEmail, action.subject || `Reminder: ${action.message}`, body, html);
          await this.auth.finishAction(action.id);
        }
        catch (error) { await this.auth.finishAction(action.id, error instanceof Error ? error.message : 'Email delivery failed.'); }
      }
    } catch (error) {
      this.logger.error('Could not check due reminder actions.', error instanceof Error ? error.stack : String(error));
    } finally { this.running = false; }
  }
}
