import { ServiceUnavailableException } from '@nestjs/common';
import { VoiceAssistantService } from '../src/voice-assistant.service';

describe('VoiceAssistantService', () => {
  let service: VoiceAssistantService;
  const originalKey = process.env.GEMINI_API_KEY;
  const tomorrowInLagos = () => {
    const date = new Date(); date.setDate(date.getDate() + 1);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
  };

  beforeEach(() => { service = new VoiceAssistantService(); process.env.GEMINI_API_KEY = 'test-secret'; });
  afterAll(() => { if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey; });

  const stubModel = (turn: Record<string, any>) => jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(turn) }] } }] }) } as Response);
  const modelTurn = (extra = {}) => ({ intent: 'new_action', actionType: 'personal_reminder', title: 'Submit report', message: '', recipientName: '', scheduledDate: tomorrowInLagos(), scheduledTime: '23:59', ...extra });

  it('interprets a personal reminder and returns a future zoned time without executing it', async () => {
    const fetchMock = stubModel(modelTurn());
    try {
      const result = await service.interpret({ transcript: 'Remind me tomorrow at 11:59 PM to submit my report.', timezone: 'Africa/Lagos', messages: [] }, 'guest:test');
      expect(result).toEqual(expect.objectContaining({ intent: 'new_action', actionType: 'personal_reminder', ready: true, draft: expect.objectContaining({ title: 'Submit report', scheduledTime: '23:59', timezone: 'Africa/Lagos' }) }));
      expect(result.scheduledAt).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'), expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-goog-api-key': 'test-secret' }) }));
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).generationConfig.responseMimeType).toBe('application/json');
    } finally { fetchMock.mockRestore(); }
  });

  it('requires an explicit spoken or drafted recipient email for email reminders', async () => {
    const fetchMock = stubModel(modelTurn({ actionType: 'schedule_email', intent: 'new_action', title: '', message: 'Finish the homepage design', recipientName: 'Michael' }));
    try {
      const missing = await service.interpret({ transcript: 'Email Michael tomorrow at 11:59 PM about finishing the homepage design.', timezone: 'Africa/Lagos' }, 'user:test');
      expect(missing.ready).toBe(false);
      expect(missing.question).toContain('email address');
      const withEmail = await service.interpret({ transcript: 'His email is michael@example.com', timezone: 'Africa/Lagos', currentDraft: missing.draft }, 'user:test');
      expect(withEmail.draft?.recipientEmail).toBe('michael@example.com');
    } finally { fetchMock.mockRestore(); }
  });

  it('preserves email and recipient during a correction and never treats a correction as confirmation', async () => {
    const fetchMock = stubModel(modelTurn({ intent: 'correction', actionType: 'schedule_email', title: '', message: 'Finish the homepage design', recipientName: 'Michael', scheduledTime: '18:00' }));
    try {
      const result = await service.interpret({ transcript: 'No, change it to 6 PM.', timezone: 'Africa/Lagos', currentDraft: { draftId: '11111111-1111-4111-8111-111111111111', actionType: 'schedule_email', recipientName: 'Michael', recipientEmail: 'michael@example.com', message: 'Finish the homepage design', scheduledDate: tomorrowInLagos(), scheduledTime: '16:00', timezone: 'Africa/Lagos' } }, 'user:test');
      expect(result.intent).toBe('correction');
      expect(result.draft).toEqual(expect.objectContaining({ recipientEmail: 'michael@example.com', recipientName: 'Michael', scheduledTime: '18:00' }));
      expect(result.assistantText).toContain('6:00 PM');
    } finally { fetchMock.mockRestore(); }
  });

  it('requires GEMINI_API_KEY instead of pretending to interpret a request', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(service.interpret({ transcript: 'Remind me tomorrow at 9 AM to submit my report', timezone: 'Africa/Lagos' }, 'guest:test')).rejects.toThrow(ServiceUnavailableException);
  });
});
