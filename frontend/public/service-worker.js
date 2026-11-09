self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { title: 'Spectre reminder', body: 'You have a task reminder.' }; }
  const title = message.title || 'Task reminder';
  const options = {
    body: message.body || 'A task reminder is due.',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: message.taskId ? `spectre-task-${message.taskId}` : 'spectre-reminder',
    data: { taskId: message.taskId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  const url = taskId ? `/?task=${encodeURIComponent(taskId)}` : '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('navigate' in client) await client.navigate(url);
      return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});
