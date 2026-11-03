import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SpectreService } from './spectre.service';
import { AuthService, RequestIdentity } from './auth.service';
import { SupabaseService } from './supabase.service';
import { VoiceAssistantService } from './voice-assistant.service';

type IdentityRequest = Request & { identity?: RequestIdentity };

@Controller('api')
export class AppController {
  constructor(private readonly service: SpectreService, private readonly auth: AuthService, private readonly supabase: SupabaseService, private readonly voice: VoiceAssistantService) {}

  @Get('health') health() { return { status: 'ok', service: 'spectre-api' }; }
  @Get('health/supabase') supabaseHealth() { return this.supabase.checkConnection(); }

  @Post('auth/signup') async signup(@Body() body: Record<string, any>, @Req() request: IdentityRequest, @Res({ passthrough: true }) response: Response) {
    if (request.identity?.type !== 'guest') throw new UnauthorizedException('Sign out before creating another account.');
    const result = await this.auth.register(body); this.setSession(response, result.session); return result.user;
  }
  @Post('auth/login') async login(@Body() body: Record<string, any>, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(body); this.setSession(response, result.session); return result.user;
  }
  @Post('auth/logout') async logout(@Req() request: IdentityRequest, @Res({ passthrough: true }) response: Response) { await this.auth.logout(request.headers.cookie); response.clearCookie('spectre_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' }); return { status: 'ok' }; }
  @Get('auth/me') me(@Req() request: IdentityRequest) { return request.identity?.type === 'user' ? this.auth.getUser(request.identity.id) : null; }
  @Post('auth/guest') async guestAccount(@Req() request: IdentityRequest, @Res({ passthrough: true }) response: Response) {
    if (request.identity?.type !== 'guest') throw new UnauthorizedException('Authenticated users do not need a guest account.');
    const account = request.identity.guestUserId
      ? { guestUserId: request.identity.guestUserId, created: false }
      : await this.auth.ensureGuestAccount(request.identity.deviceId);
    if (request.identity.guestUserId && !(await this.auth.getGuestAccount(request.identity.guestUserId))) throw new UnauthorizedException('Guest account is no longer available.');
    response.cookie('guest_user_id', account.guestUserId, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
    return account;
  }
  @Post('auth/password-reset') passwordReset(@Body('email') email: string) { return this.auth.requestPasswordReset(email); }
  @Post('auth/password-reset/confirm') confirmPasswordReset(@Body() body: Record<string, any>) { return this.auth.resetPassword(body.token, body.password); }
  @Post('auth/transfer-guest') transferGuest(@Req() request: IdentityRequest, @Body() body: Record<string, any>) {
    const userId = this.requireUser(request);
    const guestUserId = this.auth.guestCookieId(request.headers.cookie);
    if (!guestUserId) throw new UnauthorizedException('The guest account is no longer available on this device.');
    return this.auth.transferGuestData(userId, guestUserId, body.confirm === true);
  }

  @Post('assistant/interpret') interpretAssistant(@Req() request: IdentityRequest, @Body() body: Record<string, any>) {
    if (!request.identity) throw new UnauthorizedException('Open a guest workspace before using the assistant.');
    const identityKey = request.identity.type === 'user' ? `user:${request.identity.id}` : `guest:${request.identity.deviceId}`;
    return this.voice.interpret(body, identityKey);
  }

  @Post('scheduled-actions') schedule(@Req() request: IdentityRequest, @Body() body: Record<string, any>) { return this.auth.createAction(this.requireUser(request), body); }
  @Get('scheduled-actions') scheduledActions(@Req() request: IdentityRequest) { return this.auth.listActions(this.requireUser(request)); }
  @Get('scheduled-actions/:id') scheduledAction(@Req() request: IdentityRequest, @Param('id') id: string) { return this.auth.getAction(this.requireUser(request), id); }
  @Post('scheduled-actions/:id/cancel') cancelScheduledAction(@Req() request: IdentityRequest, @Param('id') id: string) { return this.auth.cancelAction(this.requireUser(request), id); }
  @Post('scheduled-actions/:id/revoke-link') revokeScheduledActionLink(@Req() request: IdentityRequest, @Param('id') id: string) { return this.auth.revokeGuestReminderAccess(this.requireUser(request), id); }
  @Post('guest/reminders/view') guestReminder(@Body('token') token: string, @Req() request: IdentityRequest) { return this.auth.getGuestReminder(token, request.ip || 'unknown'); }
  @Post('guest/reminders/acknowledge') acknowledgeGuestReminder(@Body('token') token: string, @Req() request: IdentityRequest) { return this.auth.acknowledgeGuestReminder(token, request.ip || 'unknown'); }
  @Get('notifications') notifications(@Req() request: IdentityRequest) { return this.auth.listNotifications(this.requireUser(request)); }
  @Patch('notifications/:id/read') markNotificationRead(@Req() request: IdentityRequest, @Param('id') id: string) { return this.auth.markNotificationRead(this.requireUser(request), id); }
  @Post('notifications/read-all') markAllNotificationsRead(@Req() request: IdentityRequest) { return this.auth.markAllNotificationsRead(this.requireUser(request)); }

  @Get('tasks') tasks(@Query() query: Record<string, string>) { return this.service.listTasks(query); }
  @Get('weekly-summaries') weeklySummaries(@Query('timezone') timezone?: string) { return this.service.listWeeklySummaries(timezone); }
  @Post('weekly-summaries/:id/viewed') markWeeklySummaryViewed(@Param('id') id: string) { return this.service.markWeeklySummaryViewed(id); }
  @Post('tasks') createTask(@Body() body: Record<string, any>) { return this.service.createTask(body); }
  @Put('tasks/reorder') reorder(@Body('ids') ids: string[]) { return this.service.reorderTasks(ids); }
  @Get('tasks/:id') task(@Param('id') id: string) { return this.service.getTask(id); }
  @Patch('tasks/:id') updateTask(@Param('id') id: string, @Body() body: Record<string, any>) { return this.service.updateTask(id, body); }
  @Delete('tasks/:id') deleteTask(@Param('id') id: string, @Query('series') series?: string) { return this.service.deleteTask(id, series === 'true'); }

  @Get('folders') folders() { return this.service.listFolders(); }
  @Post('folders') createFolder(@Body('name') name: string) { return this.service.createFolder(name); }
  @Delete('folders/:name') deleteFolder(@Param('name') name: string) { return this.service.deleteFolder(name); }
  @Get('tags') tags() { return this.service.listTags(); }
  @Post('tags') createTag(@Body('name') name: string) { return this.service.createTag(name); }

  @Get('notes') notes() { return this.service.listNotes(); }
  @Post('notes') createNote(@Body() body: Record<string, any>) { return this.service.createNote(body); }
  @Patch('notes/:id') updateNote(@Param('id') id: string, @Body() body: Record<string, any>) { return this.service.updateNote(id, body); }
  @Delete('notes/:id') deleteNote(@Param('id') id: string) { return this.service.deleteNote(id); }

  @Get('profile') profile() { return this.service.getProfile(); }
  @Put('profile') updateProfile(@Body() body: Record<string, any>) { return this.service.updateProfile(body); }
  @Put('auth/password') updatePassword(@Req() request: IdentityRequest, @Body() body: Record<string, any>) { return this.auth.changePassword(this.requireUser(request), body); }

  private requireUser(request: IdentityRequest) { if (request.identity?.type !== 'user') throw new UnauthorizedException('Sign in to use scheduled actions.'); return request.identity.id; }
  private setSession(response: Response, session: string) { response.cookie('spectre_session', session, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 }); }
}
