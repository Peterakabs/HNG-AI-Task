const { test, expect } = require('@playwright/test');

const taskDraft = {
  draftId: '11111111-1111-4111-8111-111111111111',
  actionType: 'personal_reminder',
  title: 'Call mom',
  message: '',
  recipientName: '',
  recipientEmail: '',
  scheduledDate: '2099-01-01',
  scheduledTime: '17:00',
  timezone: 'Africa/Lagos',
};

async function installBrowserMocks(page, { holdTaskCreation = false } = {}) {
  await page.addInitScript(() => {
    window.__recognitions = [];
    window.__spokenResponses = [];
    window.__speechCancelCount = 0;
    class FakeSpeechRecognition {
      constructor() { this.started = false; this.stopped = false; this.aborted = false; window.__recognitions.push(this); }
      start() { this.started = true; this.stopped = false; this.onstart?.(); }
      stop() { this.stopped = true; setTimeout(() => this.onend?.(), 0); }
      abort() { this.aborted = true; this.stopped = true; setTimeout(() => this.onend?.(), 0); }
    }
    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;
    window.__emitSpeech = (transcript) => {
      const recognition = [...window.__recognitions].reverse().find((item) => item.started && !item.stopped);
      if (!recognition) throw new Error('No active fake microphone session');
      const result = [{ transcript }]; result.isFinal = true;
      recognition.onresult?.({ resultIndex: 0, results: [result] });
    };
    class FakeUtterance { constructor(text) { this.text = text; } }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: FakeUtterance });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [],
      cancel: () => { window.__speechCancelCount += 1; },
      speak: (utterance) => { window.__spokenResponses.push(utterance.text); setTimeout(() => { utterance.onstart?.(); utterance.onend?.(); }, 5); },
    } });
  });

  let createdTask = null;
  let createTaskStarted;
  let resolveTaskCreateStarted;
  let releaseTaskCreate;
  if (holdTaskCreation) {
    createTaskStarted = new Promise((resolve) => { resolveTaskCreateStarted = resolve; });
  }
  const taskGate = holdTaskCreation ? new Promise((resolve) => { releaseTaskCreate = resolve; }) : null;
  const deletedTaskIds = [];
  const assistantTurns = [];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const method = request.method();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

    if (path === '/auth/me' && method === 'GET') return json(null);
    if (path === '/auth/guest' && method === 'POST') return json({ id: 'guest-e2e', created: true });
    if (path === '/tasks' && method === 'GET') return json(createdTask ? [createdTask] : []);
    if (path === '/folders' && method === 'GET') return json([]);
    if (path === '/tags' && method === 'GET') return json([]);
    if (path === '/notes' && method === 'GET') return json([]);
    if (path === '/profile' && method === 'GET') return json({ username: 'User1000' });

    if (path === '/assistant/interpret' && method === 'POST') {
      const body = request.postDataJSON();
      assistantTurns.push(body);
      if (body.currentDraft && /^(yes|yeah|yep|confirm|do it)/i.test(body.transcript.trim())) {
        return json({ intent: 'confirm', actionType: 'personal_reminder', ready: true, draft: body.currentDraft, assistantText: 'Confirmed. I’m creating your reminder now.' });
      }
      return json({ intent: 'new_action', actionType: 'personal_reminder', ready: true, draft: taskDraft, assistantText: 'I’ll remind you tomorrow at 5 PM to call Mom. Is that right?' });
    }

    if (path === '/tasks' && method === 'POST') {
      const body = request.postDataJSON();
      createdTask = { id: 'task-e2e-1', ...body, createdAt: Date.now(), order: 0 };
      if (holdTaskCreation) {
        resolveTaskCreateStarted();
        await taskGate;
      }
      return json(createdTask, 201);
    }
    if (path === '/tasks/task-e2e-1' && method === 'DELETE') {
      deletedTaskIds.push('task-e2e-1');
      createdTask = null;
      return json({ id: 'task-e2e-1' });
    }
    return json({});
  });

  return { assistantTurns, deletedTaskIds, waitForTaskCreate: () => createTaskStarted, releaseTaskCreate: () => releaseTaskCreate?.() };
}

async function openAssistant(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Spectre Assistant' }).waitFor();
  await page.getByRole('button', { name: 'Open Spectre Assistant' }).click();
  await page.getByRole('dialog', { name: 'Spectre Assistant' }).waitFor();
  await page.getByRole('button', { name: 'Speak now' }).click();
}

async function say(page, text) {
  await page.evaluate((value) => window.__emitSpeech(value), text);
}

test('keeps context through a voice confirmation and creates the reminder', async ({ page }) => {
  const { assistantTurns } = await installBrowserMocks(page);
  await openAssistant(page);

  await say(page, 'Remind me tomorrow at 5 PM to call mom');
  await expect(page.getByText(/call Mom\. Is that right\?/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__recognitions.filter((recognition) => recognition.started).length)).toBeGreaterThan(1);

  await say(page, 'Yes, do it');
  await expect(page.getByText('Your personal reminder is set.')).toBeVisible();
  await expect.poll(() => assistantTurns.length).toBe(2);
  expect(assistantTurns[1].currentDraft).toMatchObject({ title: 'Call mom', scheduledDate: '2099-01-01' });
  await expect.poll(() => page.evaluate(() => window.__spokenResponses.some((text) => text === 'Your personal reminder is set.'))).toBe(true);
});

test('closing the assistant cancels a reminder creation already in flight', async ({ page }) => {
  const { deletedTaskIds, waitForTaskCreate, releaseTaskCreate } = await installBrowserMocks(page, { holdTaskCreation: true });
  await openAssistant(page);
  await say(page, 'Remind me tomorrow at 5 PM to call mom');
  await expect(page.getByText(/call Mom\. Is that right\?/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__recognitions.filter((recognition) => recognition.started).length)).toBeGreaterThan(1);
  await say(page, 'Yes, do it');
  await waitForTaskCreate();

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Spectre Assistant' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__speechCancelCount)).toBeGreaterThan(0);
  releaseTaskCreate();
  await expect.poll(() => deletedTaskIds.length).toBe(1);
  expect(await page.evaluate(() => window.__spokenResponses.at(-1))).not.toBe('Your personal reminder is set.');
});
