import { ForbiddenException } from '@nestjs/common';
import { CollaborationService } from '../src/collaboration.service';

describe('CollaborationService (unit)', () => {
  let service: CollaborationService;
  let membership: { task_owner_user_id: string; permission: 'viewer' | 'editor' };
  let updateTask: jest.Mock;

  beforeEach(() => {
    membership = { task_owner_user_id: 'owner-1', permission: 'editor' };
    updateTask = jest.fn(async (_id, input) => ({ task: { id: 'task-1', ...input } }));
    const membershipQuery: any = { select: () => membershipQuery, eq: () => membershipQuery, maybeSingle: async () => ({ data: membership, error: null }) };
    const memberListQuery: any = { select: () => memberListQuery, eq: () => memberListQuery, then: (resolve: (value: any) => void) => resolve({ data: [], error: null }) };
    const supabase: any = { db: { from: (table: string) => table === 'notifications' ? { upsert: async () => ({ error: null }) } : table === 'task_collaborators' ? membershipQuery : memberListQuery } };
    service = new CollaborationService(supabase, {} as any, { updateTask } as any);
  });

  it('allows editors to update the shared task checklist in the owner data scope', async () => {
    const checklist = [{ id: 'item-1', text: 'Review notes', done: true }];
    await service.updateSharedTask('editor-1', 'task-1', { subtasks: checklist, title: 'Edited', ownerUserId: 'forged' });
    expect(updateTask).toHaveBeenCalledWith('task-1', { title: 'Edited', subtasks: checklist }, 'user:owner-1', 'editor-1');
  });

  it('blocks viewers from editing the task or checklist', async () => {
    membership.permission = 'viewer';
    await expect(service.updateSharedTask('viewer-1', 'task-1', { subtasks: [{ text: 'No access' }] })).rejects.toThrow(ForbiddenException);
    expect(updateTask).not.toHaveBeenCalled();
  });
});
