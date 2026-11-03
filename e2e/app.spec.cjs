const { test, expect } = require('@playwright/test');

async function installAppApi(page, { user = null } = {}) {
  const state = {
    tasks: [],
    folders: [],
    tags: [],
    notes: [],
    scheduledActions: [],
    user,
    username: 'User1000',
    nextId: 1,
    calls: [],
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    const method = request.method();
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? request.postDataJSON() : {};
    state.calls.push({ method, path, body });
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

    if (path === '/auth/me' && method === 'GET') return json(state.user);
    if (path === '/auth/guest' && method === 'POST') return json({ id: 'guest-app-e2e', created: true });
    if (['/auth/signup', '/auth/login'].includes(path) && method === 'POST') {
      state.user = { id: 'user-app-e2e', email: body.email };
      return json(state.user);
    }
    if (path === '/auth/logout' && method === 'POST') {
      state.user = null;
      return json({ ok: true });
    }
    if (path === '/notifications' && method === 'GET') return json({ notifications: [], unreadCount: 0 });
    if (path === '/tasks' && method === 'GET') return json(state.tasks);
    if (path === '/tasks' && method === 'POST') {
      const task = { id: `task-${state.nextId++}`, ...body, createdAt: Date.now(), order: state.tasks.length };
      state.tasks.push(task);
      return json(task, 201);
    }
    if (path === '/tasks/reorder' && method === 'PUT') return json({ ok: true });
    const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const index = state.tasks.findIndex((task) => task.id === decodeURIComponent(taskMatch[1]));
      if (index < 0) return json({ message: 'Task not found' }, 404);
      if (method === 'GET') return json(state.tasks[index]);
      if (method === 'PATCH') {
        state.tasks[index] = { ...state.tasks[index], ...body };
        return json({ task: state.tasks[index] });
      }
      if (method === 'DELETE') {
        const [deleted] = state.tasks.splice(index, 1);
        return json(deleted);
      }
    }
    if (path === '/folders' && method === 'GET') return json(state.folders);
    if (path === '/folders' && method === 'POST') {
      if (!state.folders.includes(body.name)) state.folders.push(body.name);
      return json({ name: body.name }, 201);
    }
    const folderMatch = path.match(/^\/folders\/([^/]+)$/);
    if (folderMatch && method === 'DELETE') {
      state.folders = state.folders.filter((folder) => folder !== decodeURIComponent(folderMatch[1]));
      return json({ ok: true });
    }
    if (path === '/tags' && method === 'GET') return json(state.tags);
    if (path === '/tags' && method === 'POST') {
      if (!state.tags.includes(body.name)) state.tags.push(body.name);
      return json({ name: body.name }, 201);
    }
    if (path === '/notes' && method === 'GET') return json(state.notes);
    if (path === '/notes' && method === 'POST') {
      const note = { id: `note-${state.nextId++}`, ...body, createdAt: Date.now() };
      state.notes.push(note);
      return json(note, 201);
    }
    const noteMatch = path.match(/^\/notes\/([^/]+)$/);
    if (noteMatch) {
      const index = state.notes.findIndex((note) => note.id === decodeURIComponent(noteMatch[1]));
      if (index < 0) return json({ message: 'Note not found' }, 404);
      if (method === 'PATCH') {
        state.notes[index] = { ...state.notes[index], ...body };
        return json(state.notes[index]);
      }
      if (method === 'DELETE') {
        const [deleted] = state.notes.splice(index, 1);
        return json(deleted);
      }
    }
    if (path === '/profile' && method === 'GET') return json({ username: state.username });
    if (path === '/profile' && method === 'PUT') {
      state.username = body.username;
      return json({ username: state.username });
    }
    if (path === '/scheduled-actions' && method === 'GET') return json(state.scheduledActions);
    if (path === '/scheduled-actions' && method === 'POST') {
      const action = { id: `action-${state.nextId++}`, status: 'scheduled', ...body };
      state.scheduledActions.push(action);
      return json(action, 201);
    }
    const scheduledActionMatch = path.match(/^\/scheduled-actions\/([^/]+)\/cancel$/);
    if (scheduledActionMatch && method === 'POST') {
      const action = state.scheduledActions.find((item) => item.id === decodeURIComponent(scheduledActionMatch[1]));
      if (action) action.status = 'cancelled';
      return json(action || { ok: true });
    }
    return json({});
  });

  return state;
}

async function openApp(page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '＋ New task' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your tasks' })).toBeVisible();
}

function futureDates(days = 2) {
  const start = new Date();
  start.setDate(start.getDate() + days);
  const date = [start.getFullYear(), String(start.getMonth() + 1).padStart(2, '0'), String(start.getDate()).padStart(2, '0')].join('-');
  return { date, due: `${date}T17:30` };
}

test('task lifecycle: create, search, edit, complete, and delete', async ({ page }) => {
  const api = await installAppApi(page);
  await openApp(page);

  await page.getByRole('button', { name: '＋ New task' }).click();
  await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
  const dates = futureDates();
  await page.getByLabel(/Task title/).fill('Review quarterly plan');
  await page.getByLabel(/Start date/).fill(dates.date);
  await page.getByLabel(/Due date/).fill(dates.due);
  await page.getByText('＋ Optional details').click();
  await page.getByLabel(/Description/).fill('Check goals and milestones');
  await page.getByRole('button', { name: 'Save task' }).click();

  await expect(page.getByText('Task created.')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'All tasks' }).click();
  await expect(page.getByText('Review quarterly plan')).toBeVisible();
  await expect(page.getByText('Check goals and milestones')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search tasks by title' }).fill('quarterly');
  await expect(page.getByText('Review quarterly plan')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search tasks by title' }).fill('not a task');
  await expect(page.getByText('No matching tasks')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search tasks by title' }).fill('');

  await page.locator('.task-quick').click();
  await page.getByLabel(/Task title/).fill('Review annual plan');
  await page.getByRole('button', { name: 'Save task' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Review annual plan')).toBeVisible();
  await expect.poll(() => api.tasks[0]?.title).toBe('Review annual plan');

  await page.getByText('Review annual plan').click();
  await expect(page.getByRole('heading', { name: 'Review annual plan' })).toBeVisible();
  await page.getByRole('button', { name: 'Mark complete' }).click();
  await expect.poll(() => api.tasks[0]?.status).toBe('Completed');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete task' }).click();
  await expect.poll(() => api.tasks).toHaveLength(0);
});

test('creates folders and tags', async ({ page }) => {
  const api = await installAppApi(page);
  await openApp(page);

  await page.getByRole('button', { name: 'Create folder' }).first().click();
  await page.getByLabel('Folder name').fill('Home projects');
  await page.getByRole('button', { name: 'Create folder', exact: true }).last().click();
  await expect(page.getByRole('button', { name: /Home projects/ })).toBeVisible();
  await expect.poll(() => api.folders).toContain('Home projects');
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: '＋ Create tag' }).click();
  await page.getByLabel('Tag name').fill('Planning');
  await page.getByRole('button', { name: 'Create tag', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Planning' })).toBeVisible();
  await expect.poll(() => api.tags).toContain('Planning');
  await page.getByRole('button', { name: 'Done' }).click();
});

test('creates a note and updates the username', async ({ page }) => {
  const api = await installAppApi(page);
  await openApp(page);

  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.getByLabel(/Title \(optional\)/).fill('Book idea');
  await page.getByLabel('Your note').fill('A short note saved through the app.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Book idea')).toBeVisible();
  await expect.poll(() => api.notes).toHaveLength(1);
  await expect.poll(() => api.notes[0]?.text).toBe('A short note saved through the app.');
  await page.getByRole('button', { name: 'Done' }).click();

  await page.locator('.username-button').click();
  await page.getByRole('textbox', { name: 'Username' }).fill('Peter');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Peter' })).toBeVisible();
  await expect.poll(() => api.username).toBe('Peter');
});

test('calendar day selection opens a task form prefilled for that date', async ({ page }) => {
  await installAppApi(page);
  await openApp(page);
  await page.getByRole('button', { name: 'Calendar' }).click();
  await expect(page.locator('.calendar-view')).toBeVisible();
  const day = page.locator('.cal-day:not(.outside)').nth(10);
  const expectedDate = await day.evaluate((element) => {
    const today = new Date();
    const month = new Date(today.getFullYear(), today.getMonth(), 1);
    const offset = (month.getDay() + 6) % 7;
    const dayNumber = Number(element.querySelector('span')?.textContent);
    const selected = new Date(month.getFullYear(), month.getMonth(), dayNumber);
    return [selected.getFullYear(), String(selected.getMonth() + 1).padStart(2, '0'), String(selected.getDate()).padStart(2, '0')].join('-');
  });
  await day.click();
  await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
  await expect(page.getByLabel(/Start date/)).toHaveValue(expectedDate);
  await expect(page.getByLabel(/Due date/)).toHaveValue(`${expectedDate}T09:00`);
});

test('email reminder creation requires recipient details and appears in scheduled actions', async ({ page }) => {
  const api = await installAppApi(page, { user: { id: 'signed-in-user', email: 'peter@example.com' } });
  await openApp(page);
  await page.getByRole('button', { name: '＋ New task' }).click();
  const dates = futureDates();
  await page.getByLabel(/Task title/).fill('Send the design draft');
  await page.getByLabel(/Start date/).fill(dates.date);
  await page.getByLabel(/Due date/).fill(dates.due);
  await page.getByText('＋ Optional details').click();
  await page.getByLabel(/Send an email reminder/).check();
  await page.getByRole('button', { name: 'Save task' }).click();

  await expect(page.getByRole('dialog', { name: 'Who should receive this reminder?' })).toBeVisible();
  await page.getByLabel('Name').fill('Michael');
  await page.getByLabel('Email').fill('michael@example.com');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm email reminder' })).toBeVisible();
  await page.getByRole('button', { name: 'Schedule reminder' }).click();
  await expect(page.getByText('Your email reminder is scheduled.')).toBeVisible();
  await expect.poll(() => api.scheduledActions).toHaveLength(1);
  expect(api.scheduledActions[0]).toMatchObject({ recipientName: 'Michael', recipientEmail: 'michael@example.com', confirmed: true });
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Scheduled actions' }).click();
  await expect(page.getByRole('dialog', { name: 'Scheduled actions' })).toBeVisible();
  await expect(page.getByText('Reminder to Michael')).toBeVisible();
  await expect(page.getByText('michael@example.com')).toBeVisible();
});

test('signup persists across reload, allows login, and signs out cleanly', async ({ page }) => {
  const api = await installAppApi(page);
  await openApp(page);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill('peter@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.reload();
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('dialog', { name: 'Sign out?' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Sign out?' }).getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('dialog', { name: 'Signed out' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Guest account', { exact: true })).toBeVisible();
  expect(api.user).toBeNull();

  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'I have an account' }).click();
  await page.getByLabel('Email').fill('peter@example.com');
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  expect(api.calls.some(({ path }) => path === '/auth/login')).toBe(true);
});
