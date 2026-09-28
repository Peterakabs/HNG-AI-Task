import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SpectreService } from './spectre.service';
import { AuthService, RequestIdentity } from './auth.service';

type IdentityRequest = Request & { identity?: RequestIdentity };

@Controller('api')
export class AppController {
  constructor(private readonly service: SpectreService, private readonly auth: AuthService) {}

  @Get('health') health() { return { status: 'ok', service: 'spectre-api' }; }

  @Post('auth/signup') async signup(@Body() body: Record<string, any>, @Req() request: IdentityRequest, @Res({ passthrough: true }) response: Response) {
    if (request.identity?.type !== 'guest') throw new UnauthorizedException('Sign out before creating another account.');
    const result = await this.auth.register(body, request.identity.deviceId); this.setSession(response, result.session); return result.user;
  }
  @Post('auth/login') login(@Body() body: Record<string, any>, @Res({ passthrough: true }) response: Response) {
    const result = this.auth.login(body); this.setSession(response, result.session); return result.user;
  }
  @Post('auth/logout') logout(@Res({ passthrough: true }) response: Response) { response.clearCookie('spectre_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' }); return { status: 'ok' }; }
  @Get('auth/me') me(@Req() request: IdentityRequest) { return request.identity?.type === 'user' ? this.auth.getUser(request.identity.id) : null; }

  @Post('scheduled-actions') schedule(@Req() request: IdentityRequest, @Body() body: Record<string, any>) { return this.auth.createAction(this.requireUser(request), body); }
  @Get('scheduled-actions') scheduledActions(@Req() request: IdentityRequest) { return this.auth.listActions(this.requireUser(request)); }
  @Get('scheduled-actions/:id') scheduledAction(@Req() request: IdentityRequest, @Param('id') id: string) { return this.auth.getAction(this.requireUser(request), id); }

  @Get('tasks') tasks(@Query() query: Record<string, string>) { return this.service.listTasks(query); }
  @Post('tasks') createTask(@Body() body: Record<string, any>) { return this.service.createTask(body); }
  @Put('tasks/reorder') reorder(@Body('ids') ids: string[]) { return this.service.reorderTasks(ids); }
  @Get('tasks/:id') task(@Param('id') id: string) { return this.service.getTask(id); }
  @Patch('tasks/:id') updateTask(@Param('id') id: string, @Body() body: Record<string, any>) { return this.service.updateTask(id, body); }
  @Delete('tasks/:id') deleteTask(@Param('id') id: string) { return this.service.deleteTask(id); }

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

  private requireUser(request: IdentityRequest) { if (request.identity?.type !== 'user') throw new UnauthorizedException('Sign in to use scheduled actions.'); return request.identity.id; }
  private setSession(response: Response, session: string) { response.cookie('spectre_session', session, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 }); }
}
