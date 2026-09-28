import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const api = async (path, options = {}) => {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
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
const emptyTask = (defaults = {}) => ({
  title: '', description: '', start: defaults.start || localToday(),
  due: defaults.due || `${localToday()}T17:00`, status: 'To Do', priority: 'Medium',
  folder: defaults.folder || '', tags: defaults.tag || '', subtasks: [], attachments: [],
  notes: '', recurrence: '', reminder: '',
});

function App() {
  const [tasks, setTasks] = useState([]);
  const [folders, setFolders] = useState([]);
  const [tags, setTags] = useState([]);
  const [notes, setNotes] = useState([]);
  const [username, setUsername] = useState('User1000');
  const [view, setView] = useState('today');
  const [selectedFolder, setSelectedFolder] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedDay, setSelectedDay] = useState(localToday());
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('manual');
  const [filters, setFilters] = useState({ status: '', priority: '', tag: '', folder: '', date: '' });
  const [modal, setModal] = useState(null);
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
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [dark, setDark] = useState(() => localStorage.getItem('spectre.theme') === 'dark');

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [nextTasks, nextFolders, nextTags, nextNotes, profile] = await Promise.all([
        api('/tasks'), api('/folders'), api('/tags'), api('/notes'), api('/profile'),
      ]);
      setTasks(nextTasks); setFolders(nextFolders); setTags(nextTags); setNotes(nextNotes);
      setUsername(profile.username); setError('');
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('spectre.theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => {
    const check = async () => {
      const now = Date.now();
      for (const task of tasks) {
        if (!task.reminder || !task.due || task.status === 'Completed' || task.notified) continue;
        const due = new Date(task.due).getTime();
        const lead = task.reminder === 'at-due' ? 0 : Number(task.reminder) * 60_000;
        if (due - lead <= now && due > now - 3_600_000) {
          try { await api(`/tasks/${task.id}`, { method: 'PATCH', body: { notified: true } }); notify(`Reminder: ${task.title}`); reload(); }
          catch (err) { notify(err.message); }
        }
      }
    };
    const timer = window.setInterval(check, 30_000);
    check();
    return () => window.clearInterval(timer);
  }, [tasks, notify, reload]);

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
    const payload = { ...taskDraft, tags: [...new Set(taskDraft.tags.split(',').map((tag) => tag.trim()).filter(Boolean))], attachments: attachmentFiles };
    try {
      await api(editingId ? `/tasks/${editingId}` : '/tasks', { method: editingId ? 'PATCH' : 'POST', body: payload });
      setModal(null); await reload(); notify(editingId ? 'Task updated' : 'Task created');
    } catch (err) { notify(err.message); }
  }
  async function toggleTask(task) {
    try { const response = await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: task.status === 'Completed' ? 'To Do' : 'Completed' } }); await reload(); if (response.recurringTask) notify('Next recurring task scheduled'); if (selectedTask?.id === task.id) setSelectedTask(response.task); }
    catch (err) { notify(err.message); }
  }
  async function deleteTask(task) {
    if (!window.confirm(`Delete “${task.title}”?`)) return;
    try { await api(`/tasks/${task.id}`, { method: 'DELETE' }); setSelectedTask(null); await reload(); notify('Task deleted'); }
    catch (err) { notify(err.message); }
  }
  async function createFolder(event) {
    event.preventDefault();
    try { await api('/folders', { method: 'POST', body: { name: nameDraft } }); setNameDraft(''); setModal(null); await reload(); notify('Folder created'); }
    catch (err) { notify(err.message); }
  }
  async function createTag(event) {
    event.preventDefault();
    try { await api('/tags', { method: 'POST', body: { name: nameDraft } }); setNameDraft(''); setModal(null); await reload(); notify('Tag created'); }
    catch (err) { notify(err.message); }
  }
  async function removeFolder(folder) {
    if (!window.confirm(`Delete folder “${folder}”? Tasks will stay, without a folder.`)) return;
    try { await api(`/folders/${encodeURIComponent(folder)}`, { method: 'DELETE' }); await reload(); if (selectedFolder === folder) changeView('all'); }
    catch (err) { notify(err.message); }
  }
  async function addNote(event) {
    event.preventDefault();
    try { await api(noteEditId ? `/notes/${noteEditId}` : '/notes', { method: noteEditId ? 'PATCH' : 'POST', body: noteDraft }); setNoteDraft({ title: '', text: '' }); setNoteEditId(null); setModal(null); await reload(); notify(noteEditId ? 'Note updated' : 'Note saved'); }
    catch (err) { notify(err.message); }
  }
  function editNote(note) { setNoteDraft({ title: note.title || '', text: note.text }); setNoteEditId(note.id); setModal('note'); }
  async function removeNote(note) {
    try { await api(`/notes/${note.id}`, { method: 'DELETE' }); await reload(); }
    catch (err) { notify(err.message); }
  }
  async function changeUsername(event) {
    event.preventDefault();
    try { const profile = await api('/profile', { method: 'PUT', body: { username: usernameDraft } }); setUsername(profile.username); setModal(null); notify('Username updated'); }
    catch (err) { notify(err.message); }
  }
  function moveTask(fromId, toId) {
    const ids = tasks.map((task) => task.id); const from = ids.indexOf(fromId); const to = ids.indexOf(toId);
    ids.splice(to, 0, ids.splice(from, 1)[0]); setTasks((current) => current.map((task) => ({ ...task, order: ids.indexOf(task.id) })));
    api('/tasks/reorder', { method: 'PUT', body: { ids } }).catch((err) => { notify(err.message); reload(); });
  }
  function openFolderForm() { setNameDraft(''); setModal('folder'); }
  function openTagForm() { setNameDraft(''); setModal('tag'); }

  const navItems = [
    ['today', '◷', 'Today', todayCount || ''], ['upcoming', '▦', 'Upcoming', ''],
    ['all', '☷', 'All tasks', tasks.filter((task) => task.status !== 'Completed').length || ''],
    ['completed', '✓', 'Completed', ''], ['calendar', '▦', 'Calendar', ''],
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon">✓</span>Spectre</div>
      <section className="nav-group"><div className="navgroup-title">Workspace</div>{navItems.map(([key, icon, label, count]) => <button key={key} className={`navitem ${view === key ? 'active' : ''}`} onClick={() => changeView(key)}><span className="navicon">{icon}</span>{label}<span className="count">{count}</span></button>)}</section>
      <section className="nav-group"><div className="navgroup-title">Folders <button className="mini" title="Create folder" onClick={openFolderForm}>＋</button></div>{folders.length ? folders.map((folder) => <div className="folder-row" key={folder}><button className={`navitem ${view === 'folder' && selectedFolder === folder ? 'active' : ''}`} onClick={() => { setSelectedFolder(folder); setSelectedTag(''); setView('folder'); }}><span className="navicon">▱</span>{folder}<span className="count">{tasks.filter((task) => task.folder === folder && task.status !== 'Completed').length}</span></button><button className="mini folder-delete" title={`Delete ${folder}`} onClick={() => removeFolder(folder)}>×</button></div>) : <button className="folder-empty-action" onClick={openFolderForm}>＋ Create folder</button>}</section>
      {tags.length > 0 && <section className="nav-group"><div className="navgroup-title">Tags</div>{tags.map((tag, index) => <button className="tagline" key={tag} onClick={() => { setSelectedTag(tag); setSelectedFolder(''); setView('tag'); }}><span className={`dot dot-${index % 5}`} />{tag}</button>)}</section>}
      <button className="sidebar-tip" onClick={() => setModal('notes')}>Notes and small thoughts live here. <strong>Write a note →</strong></button>
    </aside>

    <main className="center">
      <header className="topline"><div className="top-heading"><div className="date-kicker">{fmtDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>{viewTitle[0]}<span>{viewTitle[1]}</span></h1></div><div className="top-actions"><button className="primary-add" onClick={() => startCreateTask()}>＋ New task</button><button className="username-button" title="Change username" onClick={() => { setUsernameDraft(username); setModal('username'); }}>{username}</button><button className="iconbtn" title="Reminders" onClick={() => notify(tasks.filter((task) => task.reminder && task.status !== 'Completed').length ? `${tasks.filter((task) => task.reminder && task.status !== 'Completed').length} reminders are set` : 'No reminders set')}>♧</button><button className="iconbtn" title="Toggle theme" onClick={() => setDark((value) => !value)}>◐</button><button className="iconbtn mobile-menu" title="Open navigation" onClick={() => document.body.classList.toggle('nav-open')}>☰</button><button className="iconbtn" title="Notes" onClick={() => setModal('notes')}>▤</button></div></header>
      <section className="progressbox"><div className="progress-icon">✳</div><div className="progress-copy"><div className="progress-title">{percentDone === 100 ? 'Beautifully done' : tasks.length - totalDone ? `${tasks.length - totalDone} ${tasks.length - totalDone === 1 ? 'task' : 'tasks'} in your hands` : 'A fresh start'}</div><div className="progress-sub">{totalDone ? `${totalDone} ${totalDone === 1 ? 'task' : 'tasks'} completed — keep going.` : 'Small steps make a meaningful day.'}</div></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percentDone}%` }} /></div><div className="progress-num">{percentDone}%</div></section>
      {view !== 'calendar' ? <>
        <div className="toolbar"><h2>{listTitle}</h2><div className="toolbar-actions"><input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by title" aria-label="Search tasks by title" /><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort tasks"><option value="manual">Manual order</option><option value="due">Due date</option><option value="priority">Priority</option><option value="created">Creation date</option><option value="alpha">Alphabetical</option></select></div></div>
        <div className="filters"><button className="create-tag-btn" onClick={openTagForm}>＋ Create tag</button><select aria-label="Filter status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">Any status</option>{['To Do', 'In Progress', 'Completed'].map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter priority" value={filters.priority} onChange={(event) => setFilters({ ...filters, priority: event.target.value })}><option value="">Any priority</option>{['High', 'Medium', 'Low'].map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter tag" value={filters.tag} onChange={(event) => setFilters({ ...filters, tag: event.target.value })}><option value="">Any tag</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select><select aria-label="Filter folder" value={filters.folder} onChange={(event) => setFilters({ ...filters, folder: event.target.value })}><option value="">Any folder</option>{folders.map((folder) => <option key={folder}>{folder}</option>)}</select><select aria-label="Filter date" value={filters.date} onChange={(event) => setFilters({ ...filters, date: event.target.value })}><option value="">Any date</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="week">Next 7 days</option><option value="none">No due date</option></select></div>
        <section className="task-list" aria-label="Tasks">{loading ? <div className="empty">Loading your tasks…</div> : error ? <div className="empty"><strong>Could not load Spectre</strong><span>{error}</span><button className="save-task" onClick={reload}>Retry</button></div> : visibleTasks.length ? visibleTasks.map((task) => <TaskCard key={task.id} task={task} onToggle={toggleTask} onEdit={() => editTask(task)} onOpen={() => setSelectedTask(task)} onDrop={moveTask} />) : <div className="empty"><strong>{search ? 'No matching tasks' : view === 'folder' ? 'This folder is empty' : view === 'tag' ? 'No tasks use this tag yet' : view === 'completed' ? 'No completed tasks yet' : 'No tasks to show'}</strong><span>{view === 'folder' ? 'Create a task in this folder to get started.' : view === 'tag' ? 'Create a task with this tag to get started.' : search ? 'Clear your search or add a new task.' : 'Add a task whenever you’re ready.'}</span><div className="empty-actions"><button className="save-task" onClick={() => startCreateTask({ folder: view === 'folder' ? selectedFolder : '', tag: view === 'tag' ? selectedTag : '' })}>Create task</button>{view !== 'tag' && <button className="secondary-button" onClick={openFolderForm}>Create folder</button>}</div></div>}</section>
      </> : <CalendarView tasks={tasks} month={month} setMonth={setMonth} selectedDay={selectedDay} setSelectedDay={setSelectedDay} onCreate={() => startCreateTask({ start: selectedDay, due: `${selectedDay}T09:00` })} onOpen={setSelectedTask} onToggle={toggleTask} onEdit={editTask} />}
    </main>

    <aside className={`notes-drawer ${modal === 'notes' ? 'open' : ''}`}><div className="drawer-head"><h2>Notes</h2><button className="iconbtn" aria-label="Close notes" onClick={() => setModal(null)}>×</button></div><button className="add-inline" onClick={() => { setNoteDraft({ title: '', text: '' }); setNoteEditId(null); setModal('note'); }}>＋ Write a note</button>{notes.length ? notes.map((note) => <article className="note-card" key={note.id}><div className="note-top"><strong>{note.title || 'Quick note'}</strong><div><button className="note-del" title="Edit note" onClick={() => editNote(note)}>✎</button><button className="note-del" title="Delete note" onClick={() => removeNote(note)}>×</button></div></div><div className="note-date">{fmtDate(note.createdAt)}</div><p>{note.text}</p></article>) : <div className="empty mini-empty"><strong>No notes yet</strong><span>Write a note to keep an idea handy.</span><button className="save-task" onClick={() => { setNoteDraft({ title: '', text: '' }); setNoteEditId(null); setModal('note'); }}>Create note</button></div>}</aside>

    {modal === 'task' && taskDraft && <Modal title={editingId ? 'Edit task' : 'New task'} onClose={() => setModal(null)}><form className="task-form" onSubmit={saveTask}>
      <label className="field full">Task title *<input required maxLength="140" value={taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} placeholder="What needs to get done?" /></label>
      <div className="form-grid"><label className="field">Start date *<input type="date" required value={taskDraft.start} onChange={(event) => setTaskDraft({ ...taskDraft, start: event.target.value })} /></label><label className="field">Due date & time *<input type="datetime-local" required value={taskDraft.due} onChange={(event) => setTaskDraft({ ...taskDraft, due: event.target.value })} /></label><label className="field">Status *<select value={taskDraft.status} onChange={(event) => setTaskDraft({ ...taskDraft, status: event.target.value })}>{['To Do', 'In Progress', 'Completed'].map((item) => <option key={item}>{item}</option>)}</select></label><label className="field">Priority *<select value={taskDraft.priority} onChange={(event) => setTaskDraft({ ...taskDraft, priority: event.target.value })}>{['High', 'Medium', 'Low'].map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <details className="optional-details" open={Boolean(editingId && (taskDraft.description || taskDraft.folder || taskDraft.tags || taskDraft.notes))}><summary>＋ Optional details</summary><div className="form-grid"><label className="field full">Description<textarea rows="3" value={taskDraft.description || ''} onChange={(event) => setTaskDraft({ ...taskDraft, description: event.target.value })} /></label><label className="field">Folder<select value={taskDraft.folder || ''} onChange={(event) => setTaskDraft({ ...taskDraft, folder: event.target.value })}><option value="">No folder</option>{folders.map((folder) => <option key={folder}>{folder}</option>)}</select></label><label className="field">Tags, separated by commas<input value={taskDraft.tags} onChange={(event) => setTaskDraft({ ...taskDraft, tags: event.target.value })} /></label><label className="field">Repeat<select value={taskDraft.recurrence || ''} onChange={(event) => setTaskDraft({ ...taskDraft, recurrence: event.target.value })}><option value="">Does not repeat</option>{['Daily', 'Weekly', 'Monthly'].map((item) => <option key={item}>{item}</option>)}</select></label><label className="field">Reminder<select value={taskDraft.reminder || ''} onChange={(event) => setTaskDraft({ ...taskDraft, reminder: event.target.value })}><option value="">No reminder</option><option value="at-due">At due time</option><option value="10">10 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></select></label><label className="field full">Checklist<div className="inline-add"><input value={subtaskText} onChange={(event) => setSubtaskText(event.target.value)} placeholder="Add checklist item" /><button type="button" className="iconbtn" onClick={() => { if (subtaskText.trim()) { setTaskDraft({ ...taskDraft, subtasks: [...(taskDraft.subtasks || []), { text: subtaskText.trim(), done: false }] }); setSubtaskText(''); } }}>＋</button></div><div className="chip-list">{(taskDraft.subtasks || []).map((item, index) => <button type="button" className="chip" key={`${item.text}-${index}`} onClick={() => setTaskDraft({ ...taskDraft, subtasks: taskDraft.subtasks.filter((_, i) => i !== index) })}>{item.text} ×</button>)}</div></label><label className="field full">Attachments<input type="file" multiple onChange={(event) => setAttachmentFiles([...attachmentFiles, ...[...event.target.files].map((file) => ({ name: file.name, size: file.size, type: file.type }))])} /><div className="chip-list">{attachmentFiles.map((file, index) => <button type="button" className="chip" key={`${file.name}-${index}`} onClick={() => setAttachmentFiles(attachmentFiles.filter((_, i) => i !== index))}>{file.name} ×</button>)}</div></label><label className="field full">Task notes<textarea rows="3" value={taskDraft.notes || ''} onChange={(event) => setTaskDraft({ ...taskDraft, notes: event.target.value })} /></label></div></details>
      <div className="modal-actions">{editingId && <button type="button" className="delete-task" onClick={() => { const task = tasks.find((item) => item.id === editingId); if (task) deleteTask(task); setModal(null); }}>Delete task</button>}<button className="save-task">Save task</button></div></form></Modal>}
    {modal === 'folder' && <Modal title="Create folder" onClose={() => setModal(null)}><form onSubmit={createFolder}><label className="field">Folder name<input required autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="e.g. Home" /></label><div className="modal-actions"><button className="save-task">Create folder</button></div></form></Modal>}
    {modal === 'tag' && <Modal title="Create tag" onClose={() => setModal(null)}><form onSubmit={createTag}><label className="field">Tag name<input required autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="e.g. Focus" /></label><div className="modal-actions"><button className="save-task">Create tag</button></div></form></Modal>}
    {modal === 'username' && <Modal title="Your username" onClose={() => setModal(null)}><form onSubmit={changeUsername}><label className="field">Username<input required maxLength="80" autoFocus value={usernameDraft} onChange={(event) => setUsernameDraft(event.target.value)} /></label><div className="modal-actions"><button className="save-task">Add</button></div></form></Modal>}
    {modal === 'note' && <Modal title={noteEditId ? 'Edit note' : 'New note'} onClose={() => { setModal(null); setNoteEditId(null); }}><form onSubmit={addNote}><label className="field">Title (optional)<input value={noteDraft.title} onChange={(event) => setNoteDraft({ ...noteDraft, title: event.target.value })} /></label><label className="field">Your note<textarea required rows="5" value={noteDraft.text} onChange={(event) => setNoteDraft({ ...noteDraft, text: event.target.value })} /></label><div className="modal-actions"><button className="save-task">{noteEditId ? 'Save changes' : 'Save note'}</button></div></form></Modal>}
    {selectedTask && <TaskDetail task={selectedTask} onClose={() => setSelectedTask(null)} onEdit={() => editTask(selectedTask)} onToggle={() => toggleTask(selectedTask)} onSubtask={async (index) => { const subtasks = selectedTask.subtasks.map((item, i) => i === index ? { ...item, done: !item.done } : item); try { const response = await api(`/tasks/${selectedTask.id}`, { method: 'PATCH', body: { subtasks } }); setSelectedTask(response.task); await reload(); } catch (err) { notify(err.message); } }} onDelete={() => deleteTask(selectedTask)} />}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

function TaskCard({ task, onToggle, onEdit, onOpen, onDrop }) {
  const [dragging, setDragging] = useState(false);
  const overdue = task.due && new Date(task.due) < new Date() && task.status !== 'Completed';
  return <article className={`task ${task.status === 'Completed' ? 'completed' : ''} ${dragging ? 'dragging' : ''}`} draggable onDragStart={(event) => { event.dataTransfer.setData('text/plain', task.id); setDragging(true); }} onDragEnd={() => setDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onDrop(event.dataTransfer.getData('text/plain'), task.id); }} onClick={onOpen}>
    <input className="check" type="checkbox" checked={task.status === 'Completed'} onChange={() => onToggle(task)} aria-label="Mark task complete" /><div className="task-body"><div className="task-title">{task.title}</div>{task.description && <div className="task-desc">{task.description}</div>}<div className="task-meta"><span className={`pill priority-${(task.priority || 'medium').toLowerCase()}`}>{task.priority}</span>{task.status === 'In Progress' && <span className="pill status">In Progress</span>}{(task.tags || []).slice(0, 2).map((tag) => <span className="pill tag" key={tag}>{tag}</span>)}{task.folder && <span className="pill">▱ {task.folder}</span>}{task.due && <span className={`due ${overdue ? 'overdue' : ''}`}>◷ {fmtDate(task.due)}{task.due.includes('T') ? ` · ${fmtDate(task.due, { hour: 'numeric', minute: '2-digit' })}` : ''}</span>}{task.subtasks?.length > 0 && <span className="subcount">☷ {task.subtasks.filter((item) => item.done).length}/{task.subtasks.length}</span>}{task.attachments?.length > 0 && <span className="subcount">⌁ {task.attachments.length}</span>}{task.recurrence && <span className="subcount">↻ {task.recurrence}</span>}</div></div><button className="task-quick" title="Edit task" onClick={(event) => { event.stopPropagation(); onEdit(); }}>···</button>
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
  return <section className="calendar-view"><div className="calendar-header"><button className="iconbtn" aria-label="Previous month" onClick={() => changeMonth(-1)}>‹</button><strong>{fmtDate(month, { month: 'long', year: 'numeric' })}</strong><button className="iconbtn" aria-label="Next month" onClick={() => changeMonth(1)}>›</button><button className="calendar-today" onClick={() => { const current = new Date(); setMonth(new Date(current.getFullYear(), current.getMonth(), 1)); setSelectedDay(localToday()); }}>Today</button></div><div className="calendar-grid">{weekdays.map((day) => <div className="cal-weekday" key={day}>{day}</div>)}{cells.map(({ iso, day, inMonth }) => { const rows = tasks.filter((task) => task.due?.slice(0, 10) === iso); return <div role="button" tabIndex="0" className={`cal-day ${inMonth ? '' : 'outside'} ${iso === selectedDay ? 'selected' : ''} ${iso === localToday() ? 'is-today' : ''}`} key={iso} onClick={() => setSelectedDay(iso)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedDay(iso); }}><span>{day}</span>{rows.slice(0, 3).map((task) => <button type="button" className="cal-task" key={task.id} title={`${task.title} · ${fmtDate(task.due, { year: 'numeric', month: 'long', day: 'numeric' })}`} onClick={(event) => { event.stopPropagation(); onOpen(task); }}>{task.title}<span className="hover-date">{fmtDate(task.due, { month: 'short', day: 'numeric' })}</span></button>)}{rows.length > 3 && <span className="cal-more">+{rows.length - 3} more</span>}</div>; })}</div><div className="day-agenda"><div className="agenda-head"><h2>{fmtDate(`${selectedDay}T12:00:00`, { weekday: 'long', month: 'long', day: 'numeric' })}</h2><button className="save-task" onClick={onCreate}>＋ Create task</button></div><div className="agenda-list">{dayTasks.length ? dayTasks.map((task) => <TaskCard key={task.id} task={task} onToggle={onToggle} onEdit={() => onEdit(task)} onOpen={() => onOpen(task)} onDrop={() => {}} />) : <div className="empty"><strong>No tasks this day</strong><span>Add a task for this date to see it here.</span><button className="save-task" onClick={onCreate}>Create task</button></div>}</div></div></section>;
}

function TaskDetail({ task, onClose, onEdit, onToggle, onSubtask, onDelete }) {
  return <div className="detail-page-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><article className="detail-page"><div className="detail-page-header"><button className="secondary-button" onClick={onClose}>← Back</button><div><button className="secondary-button" onClick={onToggle}>{task.status === 'Completed' ? 'Mark incomplete' : 'Mark complete'}</button><button className="secondary-button" onClick={onEdit}>Edit task</button><button className="close" aria-label="Close task details" onClick={onClose}>×</button></div></div><div className="detail-kicker">{task.status} · {task.priority}</div><h1>{task.title}</h1>{task.description && <p className="detail-description">{task.description}</p>}<div className="detail-grid">{task.start && <div><small>Start date</small><strong>{fmtDate(task.start, { year: 'numeric', month: 'long', day: 'numeric' })}</strong></div>}{task.due && <div><small>Due</small><strong>{fmtDate(task.due, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong></div>}{task.folder && <div><small>Folder</small><strong>{task.folder}</strong></div>}{task.recurrence && <div><small>Repeat</small><strong>{task.recurrence}</strong></div>}{task.reminder && <div><small>Reminder</small><strong>{task.reminder === 'at-due' ? 'At due time' : `${task.reminder} minutes before`}</strong></div>}</div>{task.tags?.length > 0 && <><h3>Tags</h3><div className="detail-tags">{task.tags.map((tag) => <span className="pill tag" key={tag}>{tag}</span>)}</div></>}{task.subtasks?.length > 0 && <><h3>Checklist</h3><ul className="detail-checklist">{task.subtasks.map((item, index) => <li key={`${item.text}-${index}`}><label><input type="checkbox" checked={item.done} onChange={() => onSubtask(index)} />{item.text}</label></li>)}</ul></>}{task.attachments?.length > 0 && <><h3>Attachments</h3><ul>{task.attachments.map((file, index) => <li key={`${file.name}-${index}`}>⌁ {file.name}</li>)}</ul></>}{task.notes && <><h3>Notes</h3><p className="detail-description">{task.notes}</p></>}<button className="delete-task detail-delete" onClick={onDelete}>Delete task</button></article></div>;
}

function Modal({ title, children, onClose }) {
  useEffect(() => { const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', closeOnEscape); return () => window.removeEventListener('keydown', closeOnEscape); }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-top"><h2>{title}</h2><button className="close" aria-label="Close" onClick={onClose}>×</button></div>{children}</section></div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
