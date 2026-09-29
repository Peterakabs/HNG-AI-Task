import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const getDeviceId = () => {
  let id = localStorage.getItem('spectre.device-id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('spectre.device-id', id); }
  return id;
};
const api = async (path, options = {}) => {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-device-id': getDeviceId(), ...options.headers },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
  return payload;
};

const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const localToday = () => isoDate(new Date());
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtDate = (value, options = { month: 'short', day: 'numeric' }) => value ? new Intl.DateTimeFormat(undefined, options).format(new Date(value)) : '';
const parseReminderRequest = (value) => {
  const match = value.match(/^\s*remind\s+(.+?)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+(today|tomorrow)\s+to\s+(.+?)\.?\s*$/i);
  if (!match) return null;
  const date = new Date(); if (match[5].toLowerCase() === 'tomorrow') date.setDate(date.getDate() + 1);
  let hour = Number(match[2]) % 12; if (match[4].toLowerCase() === 'pm') hour += 12;
  date.setHours(hour, Number(match[3] || 0), 0, 0);
  return { recipientName: match[1].trim(), title: match[6].trim(), due: `${isoDate(date)}T${String(hour).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` };
};
const emptyTask = (defaults = {}) => ({
  title: '', description: '', start: defaults.start || localToday(),
  due: defaults.due || `${localToday()}T17:00`, status: 'To Do', priority: 'Medium',
  folder: defaults.folder || '', tags: defaults.tag || '', subtasks: [], attachments: [],
  notes: '', recurrence: '', reminder: '', emailReminder: false,
});

function App() {
  const [tasks, setTasks] = useState([]);
  const [folders, setFolders] = useState([]);
  const [tags, setTags] = useState([]);
  const [notes, setNotes] = useState([]);
  const [username, setUsername] = useState('User1000');
  const [authUser, setAuthUser] = useState(null);
  const [authMode, setAuthMode] = useState('signup');
  const [authDraft, setAuthDraft] = useState({ email: '', password: '' });
  const [pendingReminder, setPendingReminder] = useState(() => { try { return JSON.parse(sessionStorage.getItem('spectre.pending-reminder') || 'null'); } catch { return null; } });
  const [recipientDraft, setRecipientDraft] = useState({ name: '', email: '' });
  const [scheduledActions, setScheduledActions] = useState([]);
  const [view, setView] = useState('today');
  const [selectedFolder, setSelectedFolder] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedDay, setSelectedDay] = useState(localToday());
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('manual');
  const [filters, setFilters] = useState({ status: '', priority: '', tag: '', folder: '', date: '' });
  const [modal, setModal] = useState(null);
  const [feedback, setFeedback] = useState({ kind: 'success', title: '', message: '' });
  const [dueAlert, setDueAlert] = useState(null);
  const [taskDraft, setTaskDraft] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [subtaskText, setSubtaskText] = useState('');
  const [attachmentFiles, setAttachmentFiles] = useState([]);
  const [noteDraft, setNoteDraft] = useState({ title: '', text: '' });
  const [noteEditId, setNoteEditId] = useState(null);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [dark, setDark] = useState(() => localStorage.getItem('spectre.theme') === 'dark');

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  }, []);
  const showFeedback = useCallback((kind, message, title) => {
    setFeedback({ kind, message, title: title || (kind === 'success' ? 'Success' : 'Something went wrong') });
    setModal('feedback');
  }, []);

  const reload = useCallback(async () => {
    try {
      const [nextTasks, nextFolders, nextTags, nextNotes, profile, user] = await Promise.all([
        api('/tasks'), api('/folders'), api('/tags'), api('/notes'), api('/profile'), api('/auth/me'),
      ]);
      if (![nextTasks, nextFolders, nextTags, nextNotes].every(Array.isArray) || !profile?.username) throw new Error('The API returned an unexpected response. Restart the updated NestJS server and try again.');
      setTasks(nextTasks); setFolders(nextFolders); setTags(nextTags); setNotes(nextNotes);
      setUsername(profile.username); setAuthUser(user); setError('');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if (pendingReminder) sessionStorage.setItem('spectre.pending-reminder', JSON.stringify(pendingReminder)); else sessionStorage.removeItem('spectre.pending-reminder'); }, [pendingReminder]);
  useEffect(() => { if (!loading && pendingReminder && !modal) setModal(authUser ? (pendingReminder.recipientEmail ? 'reminder-confirm' : 'recipient') : 'auth'); }, [loading, pendingReminder, authUser, modal]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('spectre.theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => {
    const check = async () => {
      if (dueAlert || modal) return;
      const now = Date.now();
      const task = tasks.find((item) => {
        if (!item.due || item.status === 'Completed' || item.notified) return false;
        const due = new Date(item.due).getTime();
        const lead = !item.reminder || item.reminder === 'at-due' ? 0 : Number(item.reminder) * 60_000;
        const trigger = due - lead;
        return trigger <= now && trigger > now - 60_000;
      });
      if (task) {
        try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { notified: true } }); setDueAlert(task); reload(); }
        catch (err) { showFeedback('error', err.message); }
      }
    };
    const timer = window.setInterval(check, 15_000);
    check();
    return () => window.clearInterval(timer);
  }, [tasks, dueAlert, modal, showFeedback, reload]);

  const visibleTasks = useMemo(() => {
    let rows = [...tasks];
    if (view === 'today') rows = rows.filter((task) => task.status !== 'Completed' && (!task.due || task.due.slice(0, 10) <= localToday()));
    if (view === 'upcoming') rows = rows.filter((task) => task.status !== 'Completed' && task.due && task.due.slice(0, 10) >= localToday());
    if (view === 'completed') rows = rows.filter((task) => task.status === 'Completed');
    if (view === 'folder') rows = rows.filter((task) => task.folder === selectedFolder);
    if (view === 'tag') rows = rows.filter((task) => task.tags?.includes(selectedTag));
    if (filters.status) rows = rows.filter((task) => task.status === filters.status);
    if (filters.priority) rows = rows.filter((task) => task.priority === filters.priority);
    if (filters.tag) rows = rows.filter((task) => task.tags?.includes(filters.tag));
    if (filters.folder) rows = rows.filter((task) => task.folder === filters.folder);
    if (filters.date === 'today') rows = rows.filter((task) => task.due?.slice(0, 10) === localToday());
    if (filters.date === 'overdue') rows = rows.filter((task) => task.due && task.due.slice(0, 10) < localToday() && task.status !== 'Completed');
    if (filters.date === 'none') rows = rows.filter((task) => !task.due);
    if (filters.date === 'week') { const end = new Date(); end.setDate(end.getDate() + 7); rows = rows.filter((task) => task.due && new Date(task.due) <= end); }
    if (search) rows = rows.filter((task) => task.title.toLowerCase().includes(search.toLowerCase()));
    const order = { High: 0, Medium: 1, Low: 2 };
    if (sort === 'due') rows.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    else if (sort === 'priority') rows.sort((a, b) => order[a.priority] - order[b.priority]);
    else if (sort === 'created') rows.sort((a, b) => b.createdAt - a.createdAt);
    else if (sort === 'alpha') rows.sort((a, b) => a.title.localeCompare(b.title));
    else rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return rows;
  }, [tasks, view, selectedFolder, selectedTag, filters, search, sort]);

  const totalDone = tasks.filter((task) => task.status === 'Completed').length;
  const percentDone = tasks.length ? Math.round(totalDone / tasks.length * 100) : 0;
  const todayCount = tasks.filter((task) => task.status !== 'Completed' && (!task.due || task.due.slice(0, 10) <= localToday())).length;
  const viewTitle = view === 'calendar' ? ['Your ', 'calendar.'] : view === 'upcoming' ? ['Looking ', 'ahead.'] : view === 'completed' ? ['Look what ', 'you did.'] : view === 'folder' ? [`${selectedFolder} `, 'folder.'] : view === 'tag' ? ['Tagged ', `#${selectedTag}.`] : view === 'all' ? ['All your ', 'tasks.'] : ['Today, ', 'well spent.'];
  const listTitle = view === 'today' ? 'Your tasks' : view === 'upcoming' ? 'Coming up' : view === 'completed' ? 'Completed' : view === 'folder' ? selectedFolder : view === 'tag' ? `#${selectedTag}` : 'All tasks';

  function changeView(next) { setView(next); setSelectedFolder(''); setSelectedTag(''); }
  function startCreateTask(defaults = {}) { setEditingId(null); setTaskDraft(emptyTask(defaults)); setSubtaskText(''); setAttachmentFiles([]); setModal('task'); }
  function editTask(task) { setEditingId(task.id); setTaskDraft({ ...task, tags: (task.tags || []).join(', '), due: task.due?.slice(0, 16) || '' }); setSubtaskText(''); setAttachmentFiles(task.attachments || []); setSelectedTask(null); setModal('task'); }
  async function saveTask(event) {
    event.preventDefault();
    setBusyAction('save-task');
    const parsedReminder = parseReminderRequest(taskDraft.title);
    const payload = { ...taskDraft, ...(parsedReminder ? { title: parsedReminder.title, start: parsedReminder.due.slice(0, 10), due: parsedReminder.due, emailReminder: true } : {}), tags: [...new Set(taskDraft.tags.split(',').map((tag) => tag.trim()).filter(Boolean))], attachments: attachmentFiles };
    try {
      const result = await api(editingId ? `/tasks/${editingId}` : '/tasks', { method: editingId ? 'PATCH' : 'POST', body: payload });
      const task = result.task || result;
      setModal(null); await reload(); if (!taskDraft.emailReminder && !parsedReminder) showFeedback('success', editingId ? 'Task updated.' : 'Task created.');
      if (taskDraft.emailReminder || parsedReminder) {
        setPendingReminder({ requestId: crypto.randomUUID(), taskId: task.id, title: task.title, scheduledAt: new Date(task.due).toISOString(), message: task.description || task.title, ...(parsedReminder ? { recipientName: parsedReminder.recipientName } : {}) });
        if (parsedReminder) setRecipientDraft({ name: parsedReminder.recipientName, email: '' });
        if (authUser) setModal('recipient'); else { setAuthMode('signup'); setAuthDraft({ email: '', password: '' }); setModal('auth'); }
      }
    } catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function authenticate(event) {
    event.preventDefault();
    setBusyAction('auth');
    try {
      const user = await api(`/auth/${authMode === 'signup' ? 'signup' : 'login'}`, { method: 'POST', body: authDraft });
      setAuthUser(user); setModal(null); setAuthDraft({ email: '', password: '' });
      if (pendingReminder) setModal('recipient');
      else showFeedback('success', 'You are signed in.');
      await reload();
    } catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function continueToConfirmation(event) {
    event.preventDefault();
    setPendingReminder((pending) => ({ ...pending, recipientName: recipientDraft.name.trim(), recipientEmail: recipientDraft.email.trim() }));
    setModal('reminder-confirm');
  }
  async function scheduleReminder() {
    if (!pendingReminder || !authUser) return;
    setBusyAction('schedule-reminder');
    try {
      const scheduled = await api('/scheduled-actions', { method: 'POST', body: { clientRequestId: pendingReminder.requestId, recipientName: pendingReminder.recipientName, recipientEmail: pendingReminder.recipientEmail, subject: `Reminder: ${pendingReminder.title}`, message: pendingReminder.message, scheduledAt: pendingReminder.scheduledAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, confirmed: true } });
      setModal(null);
      setPendingReminder(null); setRecipientDraft({ name: '', email: '' });
      setScheduledActions(await api('/scheduled-actions'));
      showFeedback('success', scheduled.status === 'scheduled' ? 'Your email reminder is scheduled.' : 'Your reminder was created.');
    } catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function showScheduledActions() {
    if (!authUser) { setAuthMode('signup'); setModal('auth'); notify('Sign in to view scheduled actions'); return; }
    setBusyAction('load-scheduled');
    try { setScheduledActions(await api('/scheduled-actions')); setModal('scheduled-actions'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function signOut() { setBusyAction('sign-out'); try { await api('/auth/logout', { method: 'POST' }); setAuthUser(null); setFeedback({ kind: 'success', title: 'Signed out', message: 'You have been signed out successfully.' }); setModal('feedback'); await reload(); } catch (err) { setFeedback({ kind: 'error', title: 'Sign out failed', message: err.message }); setModal('feedback'); } finally { setBusyAction(''); } }
  async function toggleTask(task) {
    setBusyAction(`toggle-${task.id}`);
    try { const response = await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: task.status === 'Completed' ? 'To Do' : 'Completed' } }); await reload(); if (response.recurringTask) notify('Next recurring task scheduled'); if (selectedTask?.id === task.id) setSelectedTask(response.task); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function deleteTask(task) {
    if (!window.confirm(`Delete “${task.title}”?`)) return;
    setBusyAction(`delete-${task.id}`);
    try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); setSelectedTask(null); await reload(); showFeedback('success', 'Task deleted.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function createFolder(event) {
    event.preventDefault();
    setBusyAction('create-folder');
    try { await api('/folders', { method: 'POST', body: { name: nameDraft } }); setNameDraft(''); await reload(); showFeedback('success', 'Folder created.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function createTag(event) {
    event.preventDefault();
    setBusyAction('create-tag');
    try { await api('/tags', { method: 'POST', body: { name: nameDraft } }); setNameDraft(''); await reload(); showFeedback('success', 'Tag created.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function removeFolder(folder) {
    if (!window.confirm(`Delete folder “${folder}”? Tasks will stay, without a folder.`)) return;
    setBusyAction(`delete-folder-${folder}`);
    try { await api(`/folders/${encodeURIComponent(folder)}`, { method: 'DELETE' }); await reload(); if (selectedFolder === folder) changeView('all'); showFeedback('success', 'Folder deleted.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function addNote(event) {
    event.preventDefault();
    setBusyAction('save-note');
    try { await api(noteEditId ? `/notes/${noteEditId}` : '/notes', { method: noteEditId ? 'PATCH' : 'POST', body: noteDraft }); setNoteDraft({ title: '', text: '' }); setNoteEditId(null); await reload(); showFeedback('success', noteEditId ? 'Note updated.' : 'Note saved.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  function editNote(note) { setNoteDraft({ title: note.title || '', text: note.text }); setNoteEditId(note.id); setModal('note'); }
  async function removeNote(note) {
    setBusyAction(`delete-note-${note.id}`);
    try { await api(`/notes/${note.id}`, { method: 'DELETE' }); await reload(); showFeedback('success', 'Note deleted.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function changeUsername(event) {
    event.preventDefault();
    setBusyAction('username');
    try { const profile = await api('/profile', { method: 'PUT', body: { username: usernameDraft } }); setUsername(profile.username); showFeedback('success', 'Username updated.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  function moveTask(fromId, toId) {
    const ids = tasks.map((task) => task.id); const from = ids.indexOf(fromId); const to = ids.indexOf(toId);
    ids.splice(to, 0, ids.splice(from, 1)[0]); setTasks((current) => current.map((task) => ({ ...task, order: ids.indexOf(task.id) })));
    api('/tasks/reorder', { method: 'PUT', body: { ids } }).catch((err) => { showFeedback('error', err.message); reload(); });
  }
  function openFolderForm() { setNameDraft(''); setModal('folder'); }
  function openTagForm() { setNameDraft(''); setModal('tag'); }

  const navItems = [
    ['today', '◷', 'Today', todayCount || ''], ['upcoming', '▦', 'Upcoming', ''],
    ['all', '☷', 'All tasks', tasks.filter((task) => task.status !== 'Completed').length || ''],
    ['completed', '✓', 'Completed', ''], ['calendar', '▦', 'Calendar', ''],
  ];

  if (loading) return <LoadingSplash />;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon">✓</span>Spectre</div>
      <section className="nav-group"><div className="navgroup-title">Workspace</div>{navItems.map(([key, icon, label, count]) => <AppButton key={key} className={`navitem ${view === key ? 'active' : ''}`} onClick={() => changeView(key)}><span className="navicon">{icon}</span>{label}<span className="count">{count}</span></AppButton>)}</section>
      <section className="nav-group"><div className="navgroup-title">Folders <AppButton className="mini" title="Create folder" onClick={openFolderForm}>＋</AppButton></div>{folders.length ? folders.map((folder) => <div className="folder-row" key={folder}><AppButton className={`navitem ${view === 'folder' && selectedFolder === folder ? 'active' : ''}`} onClick={() => { setSelectedFolder(folder); setSelectedTag(''); setView('folder'); }}><span className="navicon">▱</span>{folder}<span className="count">{tasks.filter((task) => task.folder === folder && task.status !== 'Completed').length}</span></AppButton><AppButton className="mini folder-delete" title={`Delete ${folder}`} loading={busyAction === `delete-folder-${folder}`} onClick={() => removeFolder(folder)}>×</AppButton></div>) : <AppButton className="folder-empty-action" onClick={openFolderForm}>＋ Create folder</AppButton>}</section>
      {tags.length > 0 && <section className="nav-group"><div className="navgroup-title">Tags</div>{tags.map((tag, index) => <AppButton className="tagline" key={tag} onClick={() => { setSelectedTag(tag); setSelectedFolder(''); setView('tag'); }}><span className={`dot dot-${index % 5}`} />{tag}</AppButton>)}</section>}
      <AppButton className="sidebar-tip" onClick={() => setModal('notes')}>Notes and small thoughts live here. <strong>Write a note →</strong></AppButton>
    </aside>

    <main className="center">
      <header className="topline"><div className="top-heading"><div className="date-kicker">{fmtDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>{viewTitle[0]}<span>{viewTitle[1]}</span></h1></div><div className="top-actions"><AppButton className="primary-add" onClick={() => startCreateTask()}>＋ New task</AppButton><AppButton className="username-button" title="Change username" onClick={() => { setUsernameDraft(username); setModal('username'); }}>{username}</AppButton><AppButton className="username-button" title={authUser ? 'Sign out' : 'Sign up or log in'} onClick={() => authUser ? setModal('signout-confirm') : (setAuthMode('signup'), setModal('auth'))}>{authUser ? 'Sign out' : 'Account'}</AppButton><AppButton className="iconbtn" title="Scheduled actions" loading={busyAction === 'load-scheduled'} onClick={showScheduledActions}>♧</AppButton><AppButton className="iconbtn" title="Toggle theme" onClick={() => setDark((value) => !value)}>◐</AppButton><AppButton className="iconbtn mobile-menu" title="Open navigation" onClick={() => document.body.classList.toggle('nav-open')}>☰</AppButton><AppButton className="iconbtn" title="Notes" onClick={() => setModal('notes')}>▤</AppButton></div></header>
      <section className="progressbox"><div className="progress-icon">✳</div><div className="progress-copy"><div className="progress-title">{percentDone === 100 ? 'Beautifully done' : tasks.length - totalDone ? `${tasks.length - totalDone} ${tasks.length - totalDone === 1 ? 'task' : 'tasks'} in your hands` : 'A fresh start'}</div><div className="progress-sub">{totalDone ? `${totalDone} ${totalDone === 1 ? 'task' : 'tasks'} completed — keep going.` : 'Small steps make a meaningful day.'}</div></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percentDone}%` }} /></div><div className="progress-num">{percentDone}%</div></section>
      {view !== 'calendar' ? <>
        <div className="toolbar"><h2>{listTitle}</h2><div className="toolbar-actions"><TextInput className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by title" aria-label="Search tasks by title" /><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort tasks"><option value="manual">Manual order</option><option value="due">Due date</option><option value="priority">Priority</option><option value="created">Creation date</option><option value="alpha">Alphabetical</option></select></div></div>
        <div className="filters"><AppButton className="create-tag-btn" onClick={openTagForm}>＋ Create tag</AppButton><select aria-label="Filter status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">Any status</option>{['To Do', 'In Progress', 'Completed'].map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter priority" value={filters.priority} onChange={(event) => setFilters({ ...filters, priority: event.target.value })}><option value="">Any priority</option>{['High', 'Medium', 'Low'].map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter tag" value={filters.tag} onChange={(event) => setFilters({ ...filters, tag: event.target.value })}><option value="">Any tag</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select><select aria-label="Filter folder" value={filters.folder} onChange={(event) => setFilters({ ...filters, folder: event.target.value })}><option value="">Any folder</option>{folders.map((folder) => <option key={folder}>{folder}</option>)}</select><select aria-label="Filter date" value={filters.date} onChange={(event) => setFilters({ ...filters, date: event.target.value })}><option value="">Any date</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="week">Next 7 days</option><option value="none">No due date</option></select></div>
        <section className="task-list" aria-label="Tasks">{loading ? <div className="empty">Loading your tasks…</div> : error ? <div className="empty"><strong>Could not load Spectre</strong><span>{error}</span><AppButton className="save-task" onClick={reload}>Retry</AppButton></div> : visibleTasks.length ? visibleTasks.map((task) => <TaskCard key={task.id} task={task} onToggle={toggleTask} onEdit={() => editTask(task)} onOpen={() => setSelectedTask(task)} onDrop={moveTask} />) : <div className="empty"><strong>{search ? 'No matching tasks' : view === 'folder' ? 'This folder is empty' : view === 'tag' ? 'No tasks use this tag yet' : view === 'completed' ? 'No completed tasks yet' : 'No tasks to show'}</strong><span>{view === 'folder' ? 'Create a task in this folder to get started.' : view === 'tag' ? 'Create a task with this tag to get started.' : search ? 'Clear your search or add a new task.' : 'Add a task whenever you’re ready.'}</span><div className="empty-actions"><AppButton className="save-task" onClick={() => startCreateTask({ folder: view === 'folder' ? selectedFolder : '', tag: view === 'tag' ? selectedTag : '' })}>Create task</AppButton></div></div>}</section>
      </> : <CalendarView tasks={tasks} month={month} setMonth={setMonth} selectedDay={selectedDay} setSelectedDay={setSelectedDay} onCreate={(day = selectedDay) => { setSelectedDay(day); setMonth(new Date(`${day}T12:00:00`)); startCreateTask({ start: day, due: `${day}T09:00` }); }} onOpen={setSelectedTask} onToggle={toggleTask} onEdit={editTask} />}
    </main>

    <aside className={`notes-drawer ${modal === 'notes' ? 'open' : ''}`}><div className="drawer-head"><h2>Notes</h2><AppButton className="iconbtn" aria-label="Close notes" onClick={() => setModal(null)}>×</AppButton></div><AppButton className="add-inline" onClick={() => { setNoteDraft({ title: '', text: '' }); setNoteEditId(null); setModal('note'); }}>＋ Write a note</AppButton>{notes.length ? notes.map((note) => <article className="note-card" key={note.id}><div className="note-top"><strong>{note.title || 'Quick note'}</strong><div><AppButton className="note-del" title="Edit note" onClick={() => editNote(note)}>✎</AppButton><AppButton className="note-del" title="Delete note" loading={busyAction === `delete-note-${note.id}`} onClick={() => removeNote(note)}>×</AppButton></div></div><div className="note-date">{fmtDate(note.createdAt)}</div><p>{note.text}</p></article>) : <div className="empty mini-empty"><strong>No notes yet</strong><span>Write a note to keep an idea handy.</span><AppButton className="save-task" onClick={() => { setNoteDraft({ title: '', text: '' }); setNoteEditId(null); setModal('note'); }}>Create note</AppButton></div>}</aside>

    {modal === 'task' && taskDraft && <Modal title={editingId ? 'Edit task' : 'New task'} onClose={() => setModal(null)}><form className="task-form" onSubmit={saveTask}>
      <label className="field full">Task title *<TextInput required maxLength="140" value={taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} placeholder="What needs to get done?" /></label><p className="field-hint">You can also write: “Remind Michael at 4 PM today to complete the design.”</p>
      <div className="form-grid"><label className="field">Start date *<TextInput type="date" required value={taskDraft.start} onChange={(event) => setTaskDraft({ ...taskDraft, start: event.target.value })} /></label><label className="field">Due date & time *<TextInput type="datetime-local" required value={taskDraft.due} onChange={(event) => setTaskDraft({ ...taskDraft, due: event.target.value })} /></label><label className="field">Status *<select value={taskDraft.status} onChange={(event) => setTaskDraft({ ...taskDraft, status: event.target.value })}>{['To Do', 'In Progress', 'Completed'].map((item) => <option key={item}>{item}</option>)}</select></label><label className="field">Priority *<select value={taskDraft.priority} onChange={(event) => setTaskDraft({ ...taskDraft, priority: event.target.value })}>{['High', 'Medium', 'Low'].map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <details className="optional-details" open={Boolean(editingId && (taskDraft.description || taskDraft.folder || taskDraft.tags || taskDraft.notes))}><summary>＋ Optional details</summary><div className="form-grid"><label className="field full">Description<textarea rows="3" value={taskDraft.description || ''} onChange={(event) => setTaskDraft({ ...taskDraft, description: event.target.value })} /></label><label className="field">Folder<select value={taskDraft.folder || ''} onChange={(event) => setTaskDraft({ ...taskDraft, folder: event.target.value })}><option value="">No folder</option>{folders.map((folder) => <option key={folder}>{folder}</option>)}</select></label><label className="field">Tags, separated by commas<TextInput value={taskDraft.tags} onChange={(event) => setTaskDraft({ ...taskDraft, tags: event.target.value })} /></label><label className="field">Repeat<select value={taskDraft.recurrence || ''} onChange={(event) => setTaskDraft({ ...taskDraft, recurrence: event.target.value })}><option value="">Does not repeat</option>{['Daily', 'Weekly', 'Monthly'].map((item) => <option key={item}>{item}</option>)}</select></label><label className="field">In-app reminder<select value={taskDraft.reminder || ''} onChange={(event) => setTaskDraft({ ...taskDraft, reminder: event.target.value })}><option value="">No reminder</option><option value="at-due">At due time</option><option value="10">10 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></select></label><label className="field full reminder-check"><TextInput type="checkbox" checked={Boolean(taskDraft.emailReminder)} onChange={(event) => setTaskDraft({ ...taskDraft, emailReminder: event.target.checked })} /> Send an email reminder to someone at the due time (requires sign in)</label><label className="field full">Checklist<div className="inline-add"><TextInput value={subtaskText} onChange={(event) => setSubtaskText(event.target.value)} placeholder="Add checklist item" /><AppButton type="button" className="iconbtn" onClick={() => { if (subtaskText.trim()) { setTaskDraft({ ...taskDraft, subtasks: [...(taskDraft.subtasks || []), { text: subtaskText.trim(), done: false }] }); setSubtaskText(''); } }}>＋</AppButton></div><div className="chip-list">{(taskDraft.subtasks || []).map((item, index) => <AppButton type="button" className="chip" key={`${item.text}-${index}`} onClick={() => setTaskDraft({ ...taskDraft, subtasks: taskDraft.subtasks.filter((_, i) => i !== index) })}>{item.text} ×</AppButton>)}</div></label><label className="field full">Attachments<TextInput type="file" multiple onChange={(event) => setAttachmentFiles([...attachmentFiles, ...[...event.target.files].map((file) => ({ name: file.name, size: file.size, type: file.type }))])} /><div className="chip-list">{attachmentFiles.map((file, index) => <AppButton type="button" className="chip" key={`${file.name}-${index}`} onClick={() => setAttachmentFiles(attachmentFiles.filter((_, i) => i !== index))}>{file.name} ×</AppButton>)}</div></label><label className="field full">Task notes<textarea rows="3" value={taskDraft.notes || ''} onChange={(event) => setTaskDraft({ ...taskDraft, notes: event.target.value })} /></label></div></details>
      <div className="modal-actions">{editingId && <AppButton type="button" className="delete-task" onClick={() => { const task = tasks.find((item) => item.id === editingId); if (task) deleteTask(task); setModal(null); }}>Delete task</AppButton>}<AppButton className="save-task" loading={busyAction === 'save-task'}>{busyAction === 'save-task' ? 'Saving…' : 'Save task'}</AppButton></div></form></Modal>}
    {modal === 'auth' && <Modal title={authMode === 'signup' ? 'Create your account' : 'Log in'} onClose={() => { if (pendingReminder) setPendingReminder(null); setModal(null); }}><p className="auth-copy">{pendingReminder ? 'Sign in to continue with your email reminder. Your task is saved.' : 'Use your email and password to access scheduled actions.'}</p><form className="task-form" onSubmit={authenticate}><label className="field">Email<TextInput required type="email" autoComplete="email" value={authDraft.email} onChange={(event) => setAuthDraft({ ...authDraft, email: event.target.value })} /></label><label className="field">Password<TextInput required type="password" minLength={authMode === 'signup' ? 8 : undefined} autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} value={authDraft.password} onChange={(event) => setAuthDraft({ ...authDraft, password: event.target.value })} /></label><div className="modal-actions auth-actions"><AppButton className="save-task" loading={busyAction === 'auth'}>{busyAction === 'auth' ? 'Please wait…' : authMode === 'signup' ? 'Sign up' : 'Log in'}</AppButton><AppButton type="button" className="secondary-button" onClick={() => setAuthMode(authMode === 'signup' ? 'login' : 'signup')}>{authMode === 'signup' ? 'I have an account' : 'Create account'}</AppButton></div></form></Modal>}
    {modal === 'recipient' && pendingReminder && <Modal title="Who should receive this reminder?" onClose={() => setModal(null)}><p className="auth-copy">Your task is saved. Add the recipient details before scheduling the email.</p><form className="task-form" onSubmit={continueToConfirmation}><label className="field">Name<TextInput required maxLength="200" value={recipientDraft.name} onChange={(event) => setRecipientDraft({ ...recipientDraft, name: event.target.value })} placeholder="Michael" /></label><label className="field">Email<TextInput required type="email" value={recipientDraft.email} onChange={(event) => setRecipientDraft({ ...recipientDraft, email: event.target.value })} placeholder="michael@example.com" /></label><div className="modal-actions"><AppButton type="button" className="secondary-button" onClick={() => { setModal(null); setPendingReminder(null); }}>Cancel reminder</AppButton><AppButton className="save-task">Continue</AppButton></div></form></Modal>}
    {modal === 'reminder-confirm' && pendingReminder && <Modal title="Confirm email reminder" onClose={() => setModal('recipient')}><div className="reminder-summary"><strong>{pendingReminder.recipientName}</strong><span>{pendingReminder.recipientEmail}</span><p>{pendingReminder.message}</p><span>{fmtDate(pendingReminder.scheduledAt, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div><div className="modal-actions"><AppButton className="secondary-button" onClick={() => setModal('recipient')}>Edit recipient</AppButton><AppButton className="save-task" loading={busyAction === 'schedule-reminder'} onClick={scheduleReminder}>{busyAction === 'schedule-reminder' ? 'Scheduling…' : 'Schedule reminder'}</AppButton></div></Modal>}
    {modal === 'scheduled-actions' && <Modal title="Scheduled actions" onClose={() => setModal(null)}>{scheduledActions.length ? <div className="scheduled-list">{scheduledActions.map((action) => <article className="note-card" key={action.id}><div className="note-top"><strong>{action.subject}</strong><span className="pill status">{action.status}</span></div><p>{action.recipientName} · {action.recipientEmail}</p><div className="note-date">{fmtDate(action.scheduledAt, { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · {action.timezone}</div>{action.failureReason && <p className="failure-reason">{action.failureReason}</p>}</article>)}</div> : <div className="empty"><strong>No scheduled reminders</strong><span>Create an email reminder from a task's optional details.</span></div>}</Modal>}
    {modal === 'signout-confirm' && <Modal title="Sign out?" onClose={() => setModal(null)}><p className="auth-copy">You can continue using Spectre as a guest on this device.</p><div className="modal-actions auth-actions"><AppButton className="secondary-button" onClick={() => setModal(null)}>Cancel</AppButton><AppButton className="save-task" loading={busyAction === 'sign-out'} onClick={signOut}>{busyAction === 'sign-out' ? 'Signing out…' : 'Sign out'}</AppButton></div></Modal>}
    {modal === 'feedback' && <Modal title={feedback.title} onClose={() => setModal(null)}><p className={`feedback-copy ${feedback.kind}`}>{feedback.message}</p><div className="modal-actions auth-actions"><AppButton className="save-task" onClick={() => setModal(null)}>Done</AppButton></div></Modal>}
    {dueAlert && <Modal title="Task due now" onClose={() => setDueAlert(null)}><div className="due-alert"><strong>{dueAlert.title}</strong>{dueAlert.description && <p>{dueAlert.description}</p>}<span>Due {fmtDate(dueAlert.due, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div><div className="modal-actions auth-actions"><AppButton className="secondary-button" onClick={() => setDueAlert(null)}>Dismiss</AppButton><AppButton className="save-task" onClick={() => { setSelectedTask(dueAlert); setDueAlert(null); }}>View task</AppButton></div></Modal>}
    {modal === 'folder' && <Modal title="Create folder" onClose={() => setModal(null)}><form onSubmit={createFolder}><label className="field">Folder name<TextInput required autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="e.g. Home" /></label><div className="modal-actions"><AppButton className="save-task" loading={busyAction === 'create-folder'}>{busyAction === 'create-folder' ? 'Creating…' : 'Create folder'}</AppButton></div></form></Modal>}
    {modal === 'tag' && <Modal title="Create tag" onClose={() => setModal(null)}><form onSubmit={createTag}><label className="field">Tag name<TextInput required autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="e.g. Focus" /></label><div className="modal-actions"><AppButton className="save-task" loading={busyAction === 'create-tag'}>{busyAction === 'create-tag' ? 'Creating…' : 'Create tag'}</AppButton></div></form></Modal>}
    {modal === 'username' && <Modal title="Your username" onClose={() => setModal(null)}><form onSubmit={changeUsername}><label className="field">Username<TextInput required maxLength="80" autoFocus value={usernameDraft} onChange={(event) => setUsernameDraft(event.target.value)} /></label><div className="modal-actions"><AppButton className="save-task" loading={busyAction === 'username'}>{busyAction === 'username' ? 'Saving…' : 'Add'}</AppButton></div></form></Modal>}
    {modal === 'note' && <Modal title={noteEditId ? 'Edit note' : 'New note'} onClose={() => { setModal(null); setNoteEditId(null); }}><form onSubmit={addNote}><label className="field">Title (optional)<TextInput value={noteDraft.title} onChange={(event) => setNoteDraft({ ...noteDraft, title: event.target.value })} /></label><label className="field">Your note<textarea required rows="5" value={noteDraft.text} onChange={(event) => setNoteDraft({ ...noteDraft, text: event.target.value })} /></label><div className="modal-actions"><AppButton className="save-task" loading={busyAction === 'save-note'}>{busyAction === 'save-note' ? 'Saving…' : noteEditId ? 'Save changes' : 'Save note'}</AppButton></div></form></Modal>}
    {selectedTask && <TaskDetail task={selectedTask} deleting={busyAction === `delete-${selectedTask.id}`} toggling={busyAction === `toggle-${selectedTask.id}`} savingSubtask={busyAction === `subtask-${selectedTask.id}`} onClose={() => setSelectedTask(null)} onEdit={() => editTask(selectedTask)} onToggle={() => toggleTask(selectedTask)} onSubtask={async (index) => { const subtasks = selectedTask.subtasks.map((item, i) => i === index ? { ...item, done: !item.done } : item); setBusyAction(`subtask-${selectedTask.id}`); try { const response = await api(`/tasks/${selectedTask.id}`, { method: 'PATCH', body: { subtasks } }); setSelectedTask(response.task); await reload(); } catch (err) { showFeedback('error', err.message); } finally { setBusyAction(''); } }} onDelete={() => deleteTask(selectedTask)} />}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

const AppButton = ({ className = '', loading = false, children, ...props }) => <button className={`app-button ${className}`} disabled={loading || props.disabled} aria-busy={loading || undefined} {...props}>{loading && <span className="button-spinner" aria-hidden="true" />}{children}</button>;
const TextInput = ({ className = '', ...props }) => <input className={`app-input ${className}`} {...props} />;

function LoadingSplash() {
  return <main className="splash-screen" role="status" aria-label="Loading Spectre">
    <div className="splash-content"><span className="brand-icon splash-mark">✓</span><strong className="splash-name">Spectre</strong><span className="splash-caption">Getting your workspace ready</span><span className="splash-progress" /></div>
  </main>;
}

function TaskCard({ task, onToggle, onEdit, onOpen, onDrop }) {
  const [dragging, setDragging] = useState(false);
  const [toggling, setToggling] = useState(false);
  async function handleToggle(event) {
    event.stopPropagation();
    setToggling(true);
    try { await onToggle(task); }
    finally { setToggling(false); }
  }
  const overdue = task.due && new Date(task.due) < new Date() && task.status !== 'Completed';
  return <article className={`task ${task.status === 'Completed' ? 'completed' : ''} ${dragging ? 'dragging' : ''} ${toggling ? 'is-toggling' : ''}`} draggable={!toggling} onDragStart={(event) => { event.dataTransfer.setData('text/plain', task.id); setDragging(true); }} onDragEnd={() => setDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(event.dataTransfer.getData('text/plain'), task.id); }} onClick={onOpen}>
    <TextInput className="check" type="checkbox" checked={task.status === 'Completed'} disabled={toggling} onClick={(event) => event.stopPropagation()} onChange={handleToggle} aria-label="Mark task complete" aria-busy={toggling} /><div className="task-body"><div className="task-title">{task.title}</div>{task.description && <div className="task-desc">{task.description}</div>}<div className="task-meta"><span className={`pill priority-${(task.priority || 'medium').toLowerCase()}`}>{task.priority}</span>{task.status === 'In Progress' && <span className="pill status">In Progress</span>}{(task.tags || []).slice(0, 2).map((tag) => <span className="pill tag" key={tag}>{tag}</span>)}{task.folder && <span className="pill">▱ {task.folder}</span>}{task.due && <span className={`due ${overdue ? 'overdue' : ''}`}>◷ {fmtDate(task.due)}{task.due.includes('T') ? ` · ${fmtDate(task.due, { hour: 'numeric', minute: '2-digit' })}` : ''}</span>}{task.subtasks?.length > 0 && <span className="subcount">☷ {task.subtasks.filter((item) => item.done).length}/{task.subtasks.length}</span>}{task.attachments?.length > 0 && <span className="subcount">⌁ {task.attachments.length}</span>}{task.recurrence && <span className="subcount">↻ {task.recurrence}</span>}{task.emailReminder && <span className="subcount">✉ Email reminder</span>}</div></div><AppButton className="task-quick" title="Edit task" onClick={(event) => { event.stopPropagation(); onEdit(); }}>···</AppButton>
  </article>;
}

function CalendarView({ tasks, month, setMonth, selectedDay, setSelectedDay, onCreate, onOpen, onToggle, onEdit }) {
  const year = month.getFullYear(); const monthIndex = month.getMonth();
  const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const days = new Date(year, monthIndex + 1, 0).getDate(); const previous = new Date(year, monthIndex, 0).getDate();
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cells = Array.from({ length: 42 }, (_, index) => {
    const n = index - offset + 1; const date = new Date(year, monthIndex, n);
    return { date, iso: isoDate(date), day: n < 1 ? previous + n : n > days ? n - days : n, inMonth: n > 0 && n <= days };
  });
  const dayTasks = tasks.filter((task) => task.due?.slice(0, 10) === selectedDay);
  const changeMonth = (amount) => { const next = new Date(year, monthIndex + amount, 1); setMonth(next); setSelectedDay(isoDate(next)); };
  return <section className="calendar-view"><div className="calendar-header"><AppButton className="iconbtn" aria-label="Previous month" onClick={() => changeMonth(-1)}>‹</AppButton><strong>{fmtDate(month, { month: 'long', year: 'numeric' })}</strong><AppButton className="iconbtn" aria-label="Next month" onClick={() => changeMonth(1)}>›</AppButton><AppButton className="calendar-today" onClick={() => { const current = new Date(); setMonth(new Date(current.getFullYear(), current.getMonth(), 1)); setSelectedDay(localToday()); }}>Today</AppButton></div><div className="calendar-grid">{weekdays.map((day) => <div className="cal-weekday" key={day}>{day}</div>)}{cells.map(({ iso, day, inMonth }) => { const rows = tasks.filter((task) => task.due?.slice(0, 10) === iso); return <div role="button" tabIndex="0" className={`cal-day ${inMonth ? '' : 'outside'} ${iso === selectedDay ? 'selected' : ''} ${iso === localToday() ? 'is-today' : ''}`} key={iso} onClick={() => onCreate(iso)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onCreate(iso); }}><span>{day}</span>{rows.slice(0, 3).map((task) => <AppButton type="button" className="cal-task" key={task.id} title={`${task.title} · ${fmtDate(task.due, { year: 'numeric', month: 'long', day: 'numeric' })}`} onClick={(event) => { event.stopPropagation(); onOpen(task); }}>{task.title}<span className="hover-date">{fmtDate(task.due, { month: 'short', day: 'numeric' })}</span></AppButton>)}{rows.length > 3 && <span className="cal-more">+{rows.length - 3} more</span>}</div>; })}</div><div className="day-agenda"><div className="agenda-head"><h2>{fmtDate(`${selectedDay}T12:00:00`, { weekday: 'long', month: 'long', day: 'numeric' })}</h2></div><div className="agenda-list">{dayTasks.length ? dayTasks.map((task) => <TaskCard key={task.id} task={task} onToggle={onToggle} onEdit={() => onEdit(task)} onOpen={() => onOpen(task)} onDrop={() => {}} />) : <div className="empty"><strong>No tasks this day</strong><span>Choose a date to create a task for it.</span></div>}</div></div></section>;
}

function TaskDetail({ task, onClose, onEdit, onToggle, onSubtask, onDelete, deleting = false, toggling = false, savingSubtask = false }) {
  return <div className="detail-page-backdrop" role="presentation"><article className="detail-page"><div className="detail-page-header"><AppButton className="secondary-button" onClick={onClose}>← Back</AppButton><div><AppButton className="secondary-button" loading={toggling} onClick={onToggle}>{toggling ? 'Updating…' : task.status === 'Completed' ? 'Mark incomplete' : 'Mark complete'}</AppButton><AppButton className="secondary-button" onClick={onEdit}>Edit task</AppButton><AppButton className="close" aria-label="Close task details" onClick={onClose}>×</AppButton></div></div><div className="detail-kicker">{task.status} · {task.priority}</div><h1>{task.title}</h1>{task.description && <p className="detail-description">{task.description}</p>}<div className="detail-grid">{task.start && <div><small>Start date</small><strong>{fmtDate(task.start, { year: 'numeric', month: 'long', day: 'numeric' })}</strong></div>}{task.due && <div><small>Due</small><strong>{fmtDate(task.due, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong></div>}{task.folder && <div><small>Folder</small><strong>{task.folder}</strong></div>}{task.recurrence && <div><small>Repeat</small><strong>{task.recurrence}</strong></div>}{task.reminder && <div><small>Reminder</small><strong>{task.reminder === 'at-due' ? 'At due time' : `${task.reminder} minutes before`}</strong></div>}{task.emailReminder && <div><small>Email reminder</small><strong>Sent at due time</strong></div>}</div>{task.tags?.length > 0 && <><h3>Tags</h3><div className="detail-tags">{task.tags.map((tag) => <span className="pill tag" key={tag}>{tag}</span>)}</div></>}{task.subtasks?.length > 0 && <><h3>Checklist</h3><ul className="detail-checklist">{task.subtasks.map((item, index) => <li key={`${item.text}-${index}`}><label><TextInput type="checkbox" checked={item.done} disabled={savingSubtask} onChange={() => onSubtask(index)} />{item.text}</label></li>)}</ul></>}{task.attachments?.length > 0 && <><h3>Attachments</h3><ul>{task.attachments.map((file, index) => <li key={`${file.name}-${index}`}>⌁ {file.name}</li>)}</ul></>}{task.notes && <><h3>Notes</h3><p className="detail-description">{task.notes}</p></>}<AppButton className="delete-task detail-delete" loading={deleting} onClick={onDelete}>{deleting ? 'Deleting…' : 'Delete task'}</AppButton></article></div>;
}

function Modal({ title, children, onClose }) {
  useEffect(() => { const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', closeOnEscape); return () => window.removeEventListener('keydown', closeOnEscape); }, [onClose]);
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-top"><h2>{title}</h2><AppButton className="close" aria-label="Close" onClick={onClose}>×</AppButton></div>{children}</section></div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
