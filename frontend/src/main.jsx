import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { googleAuth, googleAuthReady, requireGoogleAuth } from './googleAuth';

const DEVICE_ID_KEY = 'spectre.device-id';
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const getPasswordResetToken = () => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('resetToken')) return params.get('resetToken');
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return fragment.get('type') === 'recovery' ? fragment.get('access_token') || '' : '';
};
const getGuestReminderToken = () => {
  const match = window.location.hash.match(/^#reminder=([A-Za-z0-9_-]{40,64})$/);
  return match?.[1] || '';
};
let deviceIdWasLogged = false;
let guestAccountInitialization = null;
const getDeviceId = () => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (id && DEVICE_ID_PATTERN.test(id)) {
    if (!deviceIdWasLogged) console.info('[Spectre] Retrieved the persistent device ID from local storage.');
  } else {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    console.info('[Spectre] Generated and persisted a new device ID.');
  }
  deviceIdWasLogged = true;
  return id;
};
const userFacingApiError = (message, status) => {
  const raw = Array.isArray(message) ? message.join(' ') : String(message || '');
  if (/email.{0,30}(already|exists|registered)|already.{0,20}registered/i.test(raw)) return 'An account with this email already exists. Try signing in instead.';
  if (/invalid login|invalid credentials|incorrect password|wrong password/i.test(raw)) return 'The email or password is incorrect. Check your details and try again.';
  if (/password.{0,30}(weak|at least|between|contain)/i.test(raw)) return 'Choose a stronger password and try again.';
  if (/task title is required/i.test(raw)) return 'Enter a title for your task.';
  if (/valid due date|due date and time/i.test(raw)) return 'Choose a valid due date and time.';
  if (/valid email address/i.test(raw)) return 'Enter a valid email address.';
  if (/folder already exists/i.test(raw)) return 'A folder with that name already exists.';
  if (/tag already exists/i.test(raw)) return 'A tag with that name already exists.';
  if (/note text (?:is required|cannot be empty)/i.test(raw)) return 'Add some text to your note before saving.';
  if (/only scheduled or failed reminders can be cancelled/i.test(raw)) return 'This reminder can no longer be cancelled.';
  if (/already processing or finished/i.test(raw)) return 'This reminder has already started or finished.';
  if (/google calendar access expired|refresh google calendar access/i.test(raw)) return 'Google Calendar access has expired. Reconnect Google Calendar from your profile.';
  if (/reminder time must be in the future/i.test(raw)) return 'Choose a reminder time in the future.';
  if (/valid timezone is required/i.test(raw)) return 'Choose a valid time zone for this reminder.';
  if (/confirm the reminder before scheduling/i.test(raw)) return 'Please confirm the reminder details before scheduling.';
  if (/folder not found|tag not found|task not found|note not found|weekly summary not found/i.test(raw)) return 'We couldn’t find that item. It may have been removed.';
  if (/(?:route|endpoint|\/api\/|supabase|database|schema|column|relation|postgres|sqlstate|constraint|fetch failed|failed to fetch|networkerror|typeerror|econn|stack trace|internal server error|service unavailable|request failed\s*\(\d+|could not (?:load|save|update|create|delete|check|retrieve|acknowledge|cancel|revoke)[^:]{0,100}:)/i.test(raw)) {
    return status === 503 ? 'Spectre is temporarily unavailable. Please try again shortly.' : 'We couldn’t complete that right now. Please try again.';
  }
  if (status === 401) return 'Please sign in again to continue.';
  if (status === 403) return 'You don’t have permission to do that.';
  if (status === 404) return 'We couldn’t find that item. It may have been removed.';
  if (status === 409) return 'That item already exists or has changed. Refresh and try again.';
  if (status === 429) return 'Too many attempts. Wait a moment and try again.';
  if (status >= 500) return 'We couldn’t complete that right now. Please try again shortly.';
  if (status === 400) return 'Please check the information and try again.';
  if (status >= 400) return 'We couldn’t complete that. Please try again.';
  if (/(?:api key|oauth client|token|provider|resend|smtp|sendgrid)/i.test(raw)) return 'We couldn’t complete that right now. Please try again.';
  return raw && raw.length <= 220 ? raw : 'Something went wrong. Please try again.';
};
const userFacingFeedback = (message) => userFacingApiError(message, 0);
const api = async (path, options = {}) => {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    });
  } catch {
    throw new Error('Unable to connect to Spectre. Check your internet connection and try again.');
  }
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(userFacingApiError(payload?.message, response.status));
  return payload;
};
const resolveGuestAccount = () => {
  if (guestAccountInitialization) return guestAccountInitialization;
  console.info('[Spectre] Checking the backend-managed persistent guest account cookie.');
  guestAccountInitialization = api('/auth/guest', { method: 'POST', body: {}, headers: { 'x-device-id': getDeviceId() } }).then((account) => {
    console.info(account.created ? '[Spectre] Backend created this guest account.' : '[Spectre] Reused the existing backend guest account.');
    return account;
  }).catch((error) => {
    guestAccountInitialization = null;
    throw error;
  });
  return guestAccountInitialization;
};

const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const localToday = () => isoDate(new Date());
const localDateFromTimestamp = (value) => value ? isoDate(new Date(value)) : '';
const localWeekRange = (value = new Date()) => {
  const start = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start); end.setDate(end.getDate() + 6);
  return { start: isoDate(start), end: isoDate(end) };
};
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtDate = (value, options = { month: 'short', day: 'numeric' }) => value ? new Intl.DateTimeFormat(undefined, options).format(new Date(value)) : '';
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const escapeXml = (value = '') => String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
const downloadFile = (filename, content, type) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const buildOfficeZip = (entries) => {
  const encoder = new TextEncoder();
  const files = entries.map(([name, content]) => ({ name: encoder.encode(name), data: typeof content === 'string' ? encoder.encode(content) : content }));
  const crc32 = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const localParts = []; const centralParts = []; let offset = 0; let centralSize = 0;
  for (const file of files) {
    const checksum = crc32(file.data); const local = new Uint8Array(30 + file.name.length + file.data.length); const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint32(14, 0x21, true); localView.setUint32(16, checksum, true); localView.setUint32(20, file.data.length, true); localView.setUint32(24, file.data.length, true); localView.setUint16(26, file.name.length, true); local.set(file.name, 30); local.set(file.data, 30 + file.name.length); localParts.push(local);
    const central = new Uint8Array(46 + file.name.length); const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true); centralView.setUint32(14, 0x21, true); centralView.setUint32(16, checksum, true); centralView.setUint32(20, file.data.length, true); centralView.setUint32(24, file.data.length, true); centralView.setUint16(28, file.name.length, true); centralView.setUint32(42, offset, true); central.set(file.name, 46); centralParts.push(central); offset += local.length; centralSize += central.length;
  }
  const end = new Uint8Array(22); const endView = new DataView(end.buffer); endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true); endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralSize + end.length); let cursor = 0; for (const part of [...localParts, ...centralParts, end]) { result.set(part, cursor); cursor += part.length; } return result;
};
const buildXlsx = (rows) => {
  const encoder = new TextEncoder();
  const columnName = (index) => { let name = ''; for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name; return name; };
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => { const address = `${columnName(columnIndex)}${rowIndex + 1}`; return typeof cell === 'number' ? `<c r="${address}" t="n"><v>${cell}</v></c>` : `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell ?? '')}</t></is></c>`; }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Weekly Summary" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ].map(([name, content]) => ({ name: encoder.encode(name), data: encoder.encode(content) }));
  const crc32 = (bytes) => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
  const localParts = []; const centralParts = []; let offset = 0; let centralSize = 0;
  const date = 0x21;
  for (const file of files) {
    const checksum = crc32(file.data);
    const local = new Uint8Array(30 + file.name.length + file.data.length); const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(10, 0, true); localView.setUint16(12, 0, true); localView.setUint16(14, date, true); localView.setUint32(16, checksum, true); localView.setUint32(20, file.data.length, true); localView.setUint32(24, file.data.length, true); localView.setUint16(26, file.name.length, true);
    local.set(file.name, 30); local.set(file.data, 30 + file.name.length); localParts.push(local);
    const central = new Uint8Array(46 + file.name.length); const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true); centralView.setUint16(10, 0, true); centralView.setUint16(12, 0, true); centralView.setUint16(14, date, true); centralView.setUint32(16, checksum, true); centralView.setUint32(20, file.data.length, true); centralView.setUint32(24, file.data.length, true); centralView.setUint16(28, file.name.length, true); centralView.setUint32(42, offset, true);
    central.set(file.name, 46); centralParts.push(central); offset += local.length; centralSize += central.length;
  }
  const end = new Uint8Array(22); const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true); endView.setUint32(12, centralSize, true); endView.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralSize + end.length); let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) { result.set(part, cursor); cursor += part.length; }
  return result;
};
const exportWeeklySummary = (summary, username, format) => {
  const weekLabel = `${fmtDate(`${summary.weekStart}T12:00:00`, { month: 'long', day: 'numeric', year: 'numeric' })} – ${fmtDate(`${summary.weekEnd}T12:00:00`, { month: 'long', day: 'numeric', year: 'numeric' })}`;
  const filename = `spectre-weekly-summary-${summary.weekStart}`;
  if (format === 'excel') {
    const rows = [
      ['Spectre weekly summary', weekLabel], ['Completed by', username], ['Tasks completed', summary.tasks.length], [],
      ['Task', 'Description', 'Priority', 'Folder', 'Tags', 'Due date', 'Completed at', 'Task notes', 'Completed checklist items', 'Attachments'],
      ...summary.tasks.map((task) => [task.title, task.description, task.priority, task.folder, (task.tags || []).join(', '), task.due ? fmtDate(task.due, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '', task.completedAt ? fmtDate(task.completedAt, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '', task.notes, (task.subtasks || []).filter((item) => item.done).map((item) => item.text).join('; '), (task.attachments || []).map((file) => file.name).join('; ')])
    ];
    downloadFile(`${filename}.xlsx`, buildXlsx(rows), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return;
  }
  const paragraphs = [
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Your week in Spectre</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>${escapeXml(weekLabel)}</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>Hello ${escapeXml(username)},</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>${escapeXml(summary.tasks.length === 1 ? `You completed 1 task this week: ${summary.tasks[0].title}.` : `You completed ${summary.tasks.length} tasks this week.`)}</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>What you completed</w:t></w:r></w:p>`,
    ...(summary.tasks.length ? summary.tasks.flatMap((task) => {
      const details = [task.description, `Priority: ${task.priority || 'Not set'}`, task.folder ? `Folder: ${task.folder}` : '', task.tags?.length ? `Tags: ${task.tags.join(', ')}` : '', task.due ? `Due: ${fmtDate(task.due, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '', task.notes ? `Notes: ${task.notes}` : '', task.subtasks?.some((item) => item.done) ? `Checklist completed: ${task.subtasks.filter((item) => item.done).map((item) => item.text).join(', ')}` : '', task.attachments?.length ? `Attachments: ${task.attachments.map((file) => file.name).join(', ')}` : ''].filter(Boolean).join(' | ');
      return [`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${escapeXml(task.title)}</w:t></w:r></w:p>`, `<w:p><w:r><w:t>${escapeXml(details)}</w:t></w:r></w:p>`];
    }) : [`<w:p><w:r><w:t>No tasks were completed this week. Take a moment to plan your next steps.</w:t></w:r></w:p>`]),
    `<w:p><w:r><w:t>Keep building on this progress next week.</w:t></w:r></w:p>`,
  ].join('');
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const docx = buildOfficeZip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', docXml],
  ]);
  downloadFile(`${filename}.docx`, docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
};
const deliveryStatusLabel = (status) => ({ scheduled: 'Waiting to send', processing: 'Sending', sending: 'Sending', sent: 'Sent', completed: 'Sent', failed: 'Not sent', cancelled: 'Cancelled' }[status] || 'Status unavailable');
const parseReminderRequest = (value) => {
  const time = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)';
  const patterns = [
    new RegExp(`^\\s*remind\\s+(.+?)\\s+(?:at\\s+)?${time}\\s+(today|tomorrow)\\s+to\\s+(.+?)\\.?\\s*$`, 'i'),
    new RegExp(`^\\s*remind\\s+(.+?)\\s+(today|tomorrow)\\s+at\\s+${time}\\s+to\\s+(.+?)\\.?\\s*$`, 'i'),
  ];
  const [match, dateFirst] = patterns.map((pattern, index) => [value.match(pattern), index === 1]).find(([candidate]) => candidate) || [];
  if (!match) return null;
  const recipientName = match[1].trim();
  const dateLabel = dateFirst ? match[2] : match[5];
  const hourPart = dateFirst ? match[3] : match[2];
  const minutePart = dateFirst ? match[4] : match[3];
  const meridiem = dateFirst ? match[5] : match[4];
  const message = dateFirst ? match[6] : match[6];
  const date = new Date(); if (dateLabel.toLowerCase() === 'tomorrow') date.setDate(date.getDate() + 1);
  let hour = Number(hourPart) % 12; if (meridiem.toLowerCase() === 'pm') hour += 12;
  date.setHours(hour, Number(minutePart || 0), 0, 0);
  return { recipientName, title: message.trim(), due: `${isoDate(date)}T${String(hour).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` };
};
const emptyTask = (defaults = {}) => ({
  title: '', description: '',
  due: defaults.due || `${localToday()}T17:00`, status: 'To Do', priority: 'Medium',
  folder: defaults.folder || '', tags: defaults.tag || '', subtasks: [], attachments: [],
  notes: '', recurrence: '', reminder: '', emailReminder: false, remindSomeone: false,
});

function App() {
  const [tasks, setTasks] = useState([]);
  const [weeklySummaries, setWeeklySummaries] = useState([]);
  const [activeWeeklySummary, setActiveWeeklySummary] = useState(null);
  const [folders, setFolders] = useState([]);
  const [tags, setTags] = useState([]);
  const [notes, setNotes] = useState([]);
  const [username, setUsername] = useState('User1000');
  const [authUser, setAuthUser] = useState(null);
  const [googleCalendarStatus, setGoogleCalendarStatus] = useState({ connected: false, email: null });
  const [googleCalendarEvents, setGoogleCalendarEvents] = useState([]);
  const [calendarConflicts, setCalendarConflicts] = useState([]);
  const [pendingTaskPayload, setPendingTaskPayload] = useState(null);
  const [authMode, setAuthMode] = useState('signup');
  const [authDraft, setAuthDraft] = useState({ email: '', password: '' });
  const [profileDraft, setProfileDraft] = useState({ username: '', phone: '', avatarUrl: '' });
  const [deleteTarget, setDeleteTarget] = useState(null);
  const toggleRequests = useRef(new Set());
  const googleSigninCompletionRef = useRef('idle');
  const [passwordResetEmail, setPasswordResetEmail] = useState('');
  const [passwordResetPassword, setPasswordResetPassword] = useState('');
  const [passwordResetToken, setPasswordResetToken] = useState(getPasswordResetToken);
  const [guestTransferSummary, setGuestTransferSummary] = useState(null);
  const [pendingReminder, setPendingReminder] = useState(() => { try { return JSON.parse(sessionStorage.getItem('spectre.pending-reminder') || 'null'); } catch { return null; } });
  const [recipientDraft, setRecipientDraft] = useState({ name: '', email: '' });
  const [scheduledActions, setScheduledActions] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef(null);
  const notificationTriggerRef = useRef(null);
  const [view, setView] = useState('today');
  const [navOpen, setNavOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedDay, setSelectedDay] = useState(localToday());
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('manual');
  const [filters, setFilters] = useState({ status: '', priority: '', tag: '', folder: '', date: '' });
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [modal, setModal] = useState(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [feedback, setFeedback] = useState({ kind: 'success', title: '', message: '' });
  const [confirmation, setConfirmation] = useState(null);
  const [dueAlert, setDueAlert] = useState(null);
  const [taskDraft, setTaskDraft] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [subtaskText, setSubtaskText] = useState('');
  const [attachmentFiles, setAttachmentFiles] = useState([]);
  const [noteDraft, setNoteDraft] = useState({ title: '', text: '' });
  const [noteFormat, setNoteFormat] = useState('bullets');
  const noteDictationRef = useRef(null);
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
    setFeedback({ kind, message: kind === 'error' ? userFacingFeedback(message) : message, title: title || (kind === 'success' ? 'Success' : 'Something went wrong') });
    setModal('feedback');
  }, []);

  const refreshNotifications = useCallback(async () => {
    const result = await api('/notifications');
    setNotifications(result.notifications || []);
    setUnreadNotificationCount(result.unreadCount || 0);
    return result;
  }, []);

  const reload = useCallback(async () => {
    try {
      const user = await api('/auth/me');
      if (!user) await resolveGuestAccount();
      const [nextTasks, nextFolders, nextTags, nextNotes, profile] = await Promise.all([
        api('/tasks'), api('/folders'), api('/tags'), api('/notes'), api('/profile'),
      ]);
      if (![nextTasks, nextFolders, nextTags, nextNotes].every(Array.isArray) || !profile?.username) throw new Error('The API returned an unexpected response. Restart the updated NestJS server and try again.');
      setTasks(nextTasks); setFolders(nextFolders); setTags(nextTags); setNotes(nextNotes);
      setUsername(profile.username); setProfileDraft({ username: profile.username, phone: profile.phone || '', avatarUrl: profile.avatarUrl || '' }); setAuthUser(user); setError('');
      try {
        const summaries = await api(`/weekly-summaries?timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
        if (Array.isArray(summaries)) {
          setWeeklySummaries(summaries);
          const activeTasks = await api('/tasks');
          if (Array.isArray(activeTasks)) setTasks(activeTasks);
        }
      } catch (summaryError) { console.warn('[Spectre] Could not refresh weekly summaries:', summaryError.message); }
      if (user) {
        try { const result = await api('/notifications'); setNotifications(result.notifications || []); setUnreadNotificationCount(result.unreadCount || 0); }
        catch (notificationError) { console.warn('[Spectre] Could not load notifications:', notificationError.message); }
        try { setGoogleCalendarStatus(await api('/google-calendar/status')); }
        catch (calendarError) { console.warn('[Spectre] Could not load Google Calendar status:', calendarError.message); setGoogleCalendarStatus({ connected: false, email: null }); }
      } else { setNotifications([]); setUnreadNotificationCount(0); setGoogleCalendarStatus({ connected: false, email: null }); setGoogleCalendarEvents([]); }
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('googleCalendar');
    if (!result) return;
    const reason = params.get('reason');
    window.history.replaceState({}, '', window.location.pathname);
    if (result === 'connected') {
      void reload();
      showFeedback('success', 'Google Calendar is connected. Your events will appear in Calendar view.', 'Connected');
    } else {
      const message = reason === 'setup'
        ? 'Google Calendar is not ready to connect yet. Please try again later.'
        : reason === 'denied'
          ? 'Google Calendar access was not approved. Try again and allow access to view your calendar events.'
          : reason === 'state'
            ? 'The Google Calendar sign-in expired or could not be verified. Start the connection again from Spectre.'
            : reason === 'google'
              ? 'Google did not complete Calendar authorization. Check the OAuth client redirect URL and Calendar permission, then try again.'
              : reason === 'encryption'
                ? 'Google Calendar could not be connected. Please try again later.'
                : reason === 'database'
                  ? 'Google Calendar was approved, but we could not finish saving the connection. Please try again later.'
          : 'Google Calendar could not be connected. Please try again and approve the requested Calendar permission.';
      showFeedback('error', message, reason === 'setup' ? 'Google Calendar setup required' : 'Google Calendar connection failed');
    }
  }, [reload, showFeedback]);
  useEffect(() => {
    if (!googleAuth || loading) return undefined;
    const intent = sessionStorage.getItem('spectre.google.intent');
    if (intent !== 'signin') return undefined;
    const completeGoogleFlow = async (callbackSession) => {
      if (googleSigninCompletionRef.current !== 'idle' || sessionStorage.getItem('spectre.google.intent') !== 'signin') return;
      googleSigninCompletionRef.current = 'processing';
      try {
        let session = callbackSession;
        if (!session) {
          const { data, error } = await googleAuth.auth.getSession();
          if (error) throw error;
          session = data.session;
        }
        // Supabase can still be exchanging Google's callback code on the first
        // read. Keep the intent and let onAuthStateChange complete the flow.
        if (!session) { googleSigninCompletionRef.current = 'idle'; return; }
        const identity = session.user?.identities?.some((item) => item.provider === 'google') || session.user?.app_metadata?.provider === 'google';
        if (!identity) throw new Error('The Google identity could not be verified. Please try again.');
        const user = await api('/auth/google/session', { method: 'POST', body: { accessToken: session.access_token, refreshToken: session.refresh_token } });
        googleSigninCompletionRef.current = 'complete';
        sessionStorage.removeItem('spectre.google.intent');
        // The backend now owns the app session. Clear the temporary OAuth session
        // so a later sign-in starts cleanly and can select a different Google user.
        try { await googleAuth.auth.signOut({ scope: 'local' }); } catch { /* The verified backend session is already established. */ }
        const hasGuestData = tasks.length > 0 || notes.length > 0 || tags.length > 0 || folders.some((folder) => !['Personal', 'Work'].includes(folder));
        setAuthUser(user);
        if (hasGuestData) { setGuestTransferSummary({ tasks: tasks.length, notes: notes.length }); setModal('guest-transfer'); }
        else if (pendingReminder) setModal('recipient');
        else showFeedback('success', 'You are signed in with Google.');
        await reload();
        window.history.replaceState({}, '', window.location.pathname);
        sessionStorage.removeItem('spectre-google-oauth-session');
        sessionStorage.removeItem('spectre-google-oauth-session-code-verifier');
      } catch (err) {
        googleSigninCompletionRef.current = 'idle';
        sessionStorage.removeItem('spectre.google.intent');
        showFeedback('error', err.message || 'Google authentication failed.');
      }
    };
    const { data: { subscription } } = googleAuth.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') void completeGoogleFlow(session);
    });
    void completeGoogleFlow();
    return () => subscription.unsubscribe();
  }, [reload, showFeedback, notify, loading]);
  useEffect(() => {
    if (!authUser || !googleCalendarStatus.connected || view !== 'calendar') { setGoogleCalendarEvents([]); return undefined; }
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const last = new Date(first); last.setDate(last.getDate() + 42);
    let active = true;
    api(`/google-calendar/events?timeMin=${encodeURIComponent(first.toISOString())}&timeMax=${encodeURIComponent(last.toISOString())}`).then((result) => { if (active) setGoogleCalendarEvents(result.events || []); }).catch((err) => { if (active) { setGoogleCalendarEvents([]); showFeedback('error', err.message); } });
    return () => { active = false; };
  }, [authUser, googleCalendarStatus.connected, view, month, showFeedback]);
  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const summaries = await api(`/weekly-summaries?timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
        if (!Array.isArray(summaries)) return;
        setWeeklySummaries(summaries);
        const activeTasks = await api('/tasks');
        if (Array.isArray(activeTasks)) setTasks(activeTasks);
      } catch (summaryError) { console.warn('[Spectre] Could not check for a weekly summary:', summaryError.message); }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (loading || modal || assistantOpen || selectedTask) return;
    const unviewed = weeklySummaries.find((summary) => !summary.viewedAt);
    if (unviewed) { setActiveWeeklySummary(unviewed); setModal('weekly-summary'); }
  }, [weeklySummaries, loading, modal, assistantOpen, selectedTask]);
  useEffect(() => {
    if (!authUser) return undefined;
    const timer = window.setInterval(() => { refreshNotifications().catch((err) => console.warn('[Spectre] Could not refresh notifications:', err.message)); }, 30_000);
    return () => window.clearInterval(timer);
  }, [authUser, refreshNotifications]);
  useEffect(() => { if (pendingReminder) sessionStorage.setItem('spectre.pending-reminder', JSON.stringify(pendingReminder)); else sessionStorage.removeItem('spectre.pending-reminder'); }, [pendingReminder]);
  useEffect(() => { if (!loading && pendingReminder && !modal) setModal(authUser ? (pendingReminder.recipientEmail ? 'reminder-confirm' : 'recipient') : 'auth'); }, [loading, pendingReminder, authUser, modal]);
  useEffect(() => { if (passwordResetToken) setModal('password-reset'); }, [passwordResetToken]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('spectre.theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => {
    document.body.classList.toggle('nav-open', navOpen);
    return () => document.body.classList.remove('nav-open');
  }, [navOpen]);
  useEffect(() => {
    if (!notificationsOpen) return undefined;
    const dismissOutside = (event) => {
      if (notificationsRef.current?.contains(event.target) || notificationTriggerRef.current?.contains(event.target)) return;
      setNotificationsOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [notificationsOpen]);
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
    if (view === 'all') {
      const week = localWeekRange();
      rows = rows.filter((task) => {
        if (task.status === 'Completed') {
          const completed = localDateFromTimestamp(task.completedAt);
          return !completed || (completed >= week.start && completed <= week.end);
        }
        const start = task.start?.slice(0, 10) || '';
        const due = task.due?.slice(0, 10) || '';
        return (start >= week.start && start <= week.end) || (due && due <= week.end);
      });
    }
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
  const currentWeek = localWeekRange();
  const completedThisWeek = tasks.filter((task) => task.status === 'Completed' && (!task.completedAt || (localDateFromTimestamp(task.completedAt) >= currentWeek.start && localDateFromTimestamp(task.completedAt) <= currentWeek.end))).length;
  const viewTitle = view === 'calendar' ? ['Your ', 'calendar.'] : view === 'profile' ? ['Your ', 'profile.'] : view === 'upcoming' ? ['Looking ', 'ahead.'] : view === 'completed' ? ['Look what ', 'you did.'] : view === 'folder' ? [`${selectedFolder} `, 'folder.'] : view === 'tag' ? ['Tagged ', `#${selectedTag}.`] : view === 'all' ? ['Your ', 'week.'] : ['Today, ', 'well spent.'];
  const listTitle = view === 'today' ? 'Your tasks' : view === 'upcoming' ? 'Coming up' : view === 'completed' ? 'Completed' : view === 'folder' ? selectedFolder : view === 'tag' ? `#${selectedTag}` : 'This week';

  function changeView(next) { setView(next); setSelectedFolder(''); setSelectedTag(''); setNavOpen(false); }
  function startCreateTask(defaults = {}) { setEditingId(null); setTaskDraft(emptyTask(defaults)); setSubtaskText(''); setAttachmentFiles([]); setModal('task'); }
  function editTask(task) { setEditingId(task.id); setTaskDraft({ ...task, tags: (task.tags || []).join(', '), due: task.due?.slice(0, 16) || '' }); setSubtaskText(''); setAttachmentFiles(task.attachments || []); setSelectedTask(null); setModal('task'); }
  async function saveTask(event) {
    event.preventDefault();
    setBusyAction('save-task');
    const parsedReminder = parseReminderRequest(taskDraft.title);
    const { start: _legacyStart, ...taskFields } = taskDraft;
    const payload = { ...taskFields, ...(parsedReminder ? { title: parsedReminder.title, due: parsedReminder.due, emailReminder: true } : {}), tags: [...new Set(taskDraft.tags.split(',').map((tag) => tag.trim()).filter(Boolean))], attachments: attachmentFiles };
    try {
      if (!editingId && authUser && googleCalendarStatus.connected && taskDraft.due) {
        const conflicts = await api(`/google-calendar/conflicts?due=${encodeURIComponent(new Date(taskDraft.due).toISOString())}&localDate=${encodeURIComponent(taskDraft.due.slice(0, 10))}`);
        if (conflicts.events?.length) { setCalendarConflicts(conflicts.events); setPendingTaskPayload({ payload, parsedReminder }); setModal('calendar-conflict'); return; }
      }
      await persistTaskPayload(payload, parsedReminder);
    } catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function persistTaskPayload(payload, parsedReminder) {
    const result = await api(editingId ? `/tasks/${editingId}` : '/tasks', { method: editingId ? 'PATCH' : 'POST', body: payload });
    const task = result.task || result;
    setModal(null); await reload(); if (!taskDraft.emailReminder && !parsedReminder) showFeedback('success', editingId ? 'Task updated.' : 'Task created.');
    if (taskDraft.emailReminder || parsedReminder) {
      setPendingReminder({ requestId: crypto.randomUUID(), taskId: task.id, title: task.title, scheduledAt: new Date(task.due).toISOString(), message: task.description || task.title, ...(parsedReminder ? { recipientName: parsedReminder.recipientName } : {}) });
      if (parsedReminder) setRecipientDraft({ name: parsedReminder.recipientName, email: '' });
      if (authUser) setModal('recipient'); else { setAuthMode('signup'); setAuthDraft({ email: '', password: '' }); setModal('auth'); }
    }
    setPendingTaskPayload(null);
  }
  async function confirmCalendarConflict() {
    if (!pendingTaskPayload) { setModal('task'); return; }
    setBusyAction('save-task');
    try { await persistTaskPayload(pendingTaskPayload.payload, pendingTaskPayload.parsedReminder); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); setCalendarConflicts([]); }
  }
  async function authenticate(event) {
    event.preventDefault();
    setBusyAction('auth');
    try {
      const user = await api(`/auth/${authMode === 'signup' ? 'signup' : 'login'}`, { method: 'POST', body: authDraft });
      const hasGuestData = tasks.length > 0 || notes.length > 0 || tags.length > 0 || folders.some((folder) => !['Personal', 'Work'].includes(folder));
      if (hasGuestData) setGuestTransferSummary({ tasks: tasks.length, notes: notes.length });
      setAuthUser(user); setAuthDraft({ email: '', password: '' });
      if (hasGuestData) setModal('guest-transfer');
      else if (pendingReminder) setModal('recipient');
      else showFeedback('success', 'You are signed in.');
      await reload();
    } catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function startGoogleSignIn() {
    setBusyAction('google-auth');
    try {
      const client = requireGoogleAuth();
      googleSigninCompletionRef.current = 'idle';
      sessionStorage.setItem('spectre.google.intent', 'signin');
      const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin, scopes: 'openid email profile', queryParams: { prompt: 'select_account' } } });
      if (error) throw error;
    } catch (err) { sessionStorage.removeItem('spectre.google.intent'); showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function connectGoogleCalendar() {
    setBusyAction('google-calendar');
    window.location.assign('/api/google-calendar/oauth/start');
  }
  async function disconnectGoogleCalendar() {
    setBusyAction('google-calendar-disconnect');
    try { await api('/google-calendar/connect', { method: 'DELETE' }); setGoogleCalendarStatus({ connected: false, email: null }); setGoogleCalendarEvents([]); showFeedback('success', 'Google Calendar disconnected.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function finishGuestTransition(transfer) {
    setBusyAction(transfer ? 'guest-transfer' : 'finish-signin');
    try {
      const result = transfer ? await api('/auth/transfer-guest', { method: 'POST', body: { confirm: true } }) : null;
      await reload();
      setGuestTransferSummary(null);
      setModal(null);
      if (pendingReminder) { if (transfer) setPendingReminder((current) => current ? { ...current, taskId: result.taskIdMap?.[current.taskId] || null } : current); else setPendingReminder((current) => current ? { ...current, taskId: null } : current); setModal('recipient'); }
      else if (transfer) showFeedback('success', `Transferred ${result.tasksTransferred} task${result.tasksTransferred === 1 ? '' : 's'} and ${result.notesTransferred} note${result.notesTransferred === 1 ? '' : 's'}. Existing account items were preserved.`);
      else showFeedback('success', 'You are signed in. Your guest data remains on this device.');
    } catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function requestPasswordReset(event) {
    event.preventDefault(); setBusyAction('password-reset-request');
    try {
      const result = await api('/auth/password-reset', { method: 'POST', body: { email: passwordResetEmail } });
      setModal(null); showFeedback('success', result.message || 'If an account exists for that email, a password reset link has been sent.', 'Check your email');
    } catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function completePasswordReset(event) {
    event.preventDefault(); setBusyAction('password-reset-complete');
    try {
      const result = await api('/auth/password-reset/confirm', { method: 'POST', body: { token: passwordResetToken, password: passwordResetPassword } });
      setPasswordResetToken(''); setPasswordResetPassword('');
      window.history.replaceState({}, '', window.location.pathname);
      setAuthMode('login'); showFeedback('success', result.message, 'Password updated');
    } catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function continueToConfirmation(event) {
    event.preventDefault();
    setPendingReminder((pending) => ({ ...pending, recipientName: recipientDraft.name.trim(), recipientEmail: recipientDraft.email.trim() }));
    setModal('reminder-confirm');
  }
  function cancelPendingReminder() {
    setPendingReminder(null);
    setRecipientDraft({ name: '', email: '' });
    setModal(null);
    notify('Reminder cancelled. Your task is still saved.');
  }
  async function scheduleReminder() {
    if (!pendingReminder || !authUser) return;
    setBusyAction('schedule-reminder');
    try {
      const scheduled = await api('/scheduled-actions', { method: 'POST', body: { clientRequestId: pendingReminder.requestId, taskId: pendingReminder.taskId || null, recipientName: pendingReminder.recipientName, recipientEmail: pendingReminder.recipientEmail, subject: `Reminder: ${pendingReminder.title}`, message: pendingReminder.message, scheduledAt: pendingReminder.scheduledAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, confirmed: true } });
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
  async function cancelScheduledAction(action) {
    setBusyAction(`cancel-action-${action.id}`);
    try { await api(`/scheduled-actions/${action.id}/cancel`, { method: 'POST' }); setScheduledActions(await api('/scheduled-actions')); notify('Reminder cancelled.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function revokeReminderLink(action) {
    setBusyAction(`revoke-link-${action.id}`);
    try { await api(`/scheduled-actions/${action.id}/revoke-link`, { method: 'POST' }); setScheduledActions(await api('/scheduled-actions')); notify('Guest link revoked.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function openNotification(notification) {
    setNotificationsOpen(false);
    try {
      if (!notification.readAt) {
        await api(`/notifications/${notification.id}/read`, { method: 'PATCH' });
        setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt: Date.now() } : item));
        setUnreadNotificationCount((count) => Math.max(0, count - 1));
      }
      if (notification.relatedTaskId) {
        const task = tasks.find((item) => item.id === notification.relatedTaskId) || await api(`/tasks/${notification.relatedTaskId}`);
        setSelectedTask(task);
      } else if (notification.relatedScheduledActionId) await showScheduledActions();
    } catch (err) { showFeedback('error', err.message); }
  }
  async function markAllNotificationsRead() {
    try { await api('/notifications/read-all', { method: 'POST' }); setNotifications((current) => current.map((item) => ({ ...item, readAt: item.readAt || Date.now() }))); setUnreadNotificationCount(0); }
    catch (err) { showFeedback('error', err.message); }
  }
  async function signOut() { setBusyAction('sign-out'); try { await api('/auth/logout', { method: 'POST' }); setAuthUser(null); setFeedback({ kind: 'success', title: 'Signed out', message: 'You have been signed out successfully.' }); setModal('feedback'); await reload(); } catch (err) { setFeedback({ kind: 'error', title: 'Sign out failed', message: userFacingFeedback(err.message) }); setModal('feedback'); } finally { setBusyAction(''); } }
  async function toggleTask(task) {
    if (toggleRequests.current.has(task.id)) return;
    toggleRequests.current.add(task.id);
    setBusyAction(`toggle-${task.id}`);
    try { const response = await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: task.status === 'Completed' ? 'To Do' : 'Completed' } }); await reload(); if (response.recurringTask) notify('Next recurring task scheduled'); if (selectedTask?.id === task.id) setSelectedTask(response.task); }
    catch (err) { showFeedback('error', err.message); }
    finally { toggleRequests.current.delete(task.id); setBusyAction(''); }
  }
  function requestConfirmation(options) {
    setConfirmation(options);
    setModal('confirmation');
  }
  async function confirmRequestedAction() {
    const action = confirmation?.onConfirm;
    setConfirmation(null);
    setModal(null);
    if (action) await action();
  }
  async function deleteTask(task) {
    if (task.recurrence && task.recurrenceId) { setDeleteTarget(task); setModal('delete-recurring'); return; }
    requestConfirmation({ title: 'Delete task?', message: `Delete “${task.title}”? This can’t be undone.`, confirmLabel: 'Delete task', onConfirm: () => performDeleteTask(task, false) });
  }
  async function performDeleteTask(task, series) {
    setBusyAction(`delete-${task.id}`);
    try { const response = await api(`/tasks/${task.id}${series ? '?series=true' : ''}`, { method: 'DELETE' }); setSelectedTask(null); setDeleteTarget(null); setModal(null); await reload(); showFeedback('success', series ? `Deleted ${response.deletedCount || 'all'} tasks in this recurring series.` : 'Task deleted.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function closeWeeklySummary() {
    if (!activeWeeklySummary) { setModal(null); return; }
    try {
      const viewed = await api(`/weekly-summaries/${encodeURIComponent(activeWeeklySummary.id)}/viewed`, { method: 'POST' });
      setWeeklySummaries((current) => current.map((summary) => summary.id === viewed.id ? viewed : summary));
      setModal(null); setActiveWeeklySummary(null);
    } catch (err) { showFeedback('error', err.message); }
  }
  function openWeeklySummary(summary) { setActiveWeeklySummary(summary); setModal('weekly-summary'); }
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
    requestConfirmation({ title: 'Delete folder?', message: `Delete “${folder}”? Tasks in this folder will stay in your task list.`, confirmLabel: 'Delete folder', onConfirm: async () => {
      setBusyAction(`delete-folder-${folder}`);
      try { await api(`/folders/${encodeURIComponent(folder)}`, { method: 'DELETE' }); await reload(); if (selectedFolder === folder) changeView('all'); showFeedback('success', 'Folder deleted.'); }
      catch (err) { showFeedback('error', err.message); }
      finally { setBusyAction(''); }
    } });
  }
  async function removeTag(tag) {
    requestConfirmation({ title: 'Delete tag?', message: `Delete “${tag}”? It will also be removed from tasks that use it.`, confirmLabel: 'Delete tag', onConfirm: async () => {
      setBusyAction(`delete-tag-${tag}`);
      try {
        await api(`/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
        if (selectedTag === tag) changeView('all');
        setFilters((current) => current.tag === tag ? { ...current, tag: '' } : current);
        await reload();
        showFeedback('success', 'Tag deleted.');
      } catch (err) { showFeedback('error', err.message); }
      finally { setBusyAction(''); }
    } });
  }
  async function addNote(event) {
    event.preventDefault();
    setBusyAction('save-note');
    try { await api(noteEditId ? `/notes/${noteEditId}` : '/notes', { method: noteEditId ? 'PATCH' : 'POST', body: noteDraft }); setNoteDraft({ title: '', text: '' }); setNoteEditId(null); await reload(); showFeedback('success', noteEditId ? 'Note updated.' : 'Note saved.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  function editNote(note) { setNoteDraft({ title: note.title || '', text: note.text }); setNoteFormat('paragraphs'); setNoteEditId(note.id); setNavOpen(false); setModal('note'); }
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
  async function saveProfile(event) {
    event.preventDefault(); setBusyAction('profile');
    try { const saved = await api('/profile', { method: 'PUT', body: profileDraft }); setProfileDraft({ username: saved.username, phone: saved.phone || '', avatarUrl: saved.avatarUrl || '' }); setUsername(saved.username); showFeedback('success', 'Your profile was updated.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function updateProfileImage(avatarUrl) {
    setBusyAction('profile-image');
    try { const saved = await api('/profile', { method: 'PUT', body: { username: profileDraft.username || username, phone: profileDraft.phone || '', avatarUrl } }); setProfileDraft({ username: saved.username, phone: saved.phone || '', avatarUrl: saved.avatarUrl || '' }); showFeedback('success', 'Profile image updated.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  async function rearrangeNote(format = noteFormat, mode = 'polish') {
    const text = await noteDictationRef.current?.stop?.() || noteDraft.text;
    if (!text.trim()) { notify('Dictate or type some lecture notes first.'); return; }
    setNoteDraft((current) => ({ ...current, text }));
    setBusyAction('note-rewrite');
    try { const result = await api('/assistant/notes/rewrite', { method: 'POST', body: { text, format, mode } }); setNoteDraft((current) => ({ ...current, text: result.text })); setNoteFormat(format); notify(mode === 'format' ? 'Note format updated.' : 'Lecture notes rearranged.'); }
    catch (err) { notify(err.message); }
    finally { setBusyAction(''); }
  }
  async function savePassword(event) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const currentPassword = String(form.get('currentPassword') || ''); const newPassword = String(form.get('newPassword') || ''); const confirmPassword = String(form.get('confirmPassword') || '');
    if (newPassword !== confirmPassword) { showFeedback('error', 'The new passwords do not match.'); return; }
    setBusyAction('profile-password');
    try { await api('/auth/password', { method: 'PUT', body: { currentPassword, newPassword } }); formElement.reset(); showFeedback('success', 'Your password has been updated.'); }
    catch (err) { showFeedback('error', err.message); }
    finally { setBusyAction(''); }
  }
  function moveTask(fromId, toId) {
    const ids = tasks.map((task) => task.id); const from = ids.indexOf(fromId); const to = ids.indexOf(toId);
    ids.splice(to, 0, ids.splice(from, 1)[0]); setTasks((current) => current.map((task) => ({ ...task, order: ids.indexOf(task.id) })));
    api('/tasks/reorder', { method: 'PUT', body: { ids } }).catch((err) => { showFeedback('error', err.message); reload(); });
  }
  function openFolderForm() { setNameDraft(''); setNavOpen(false); setModal('folder'); }
  function openTagForm() { setNameDraft(''); setNavOpen(false); setModal('tag'); }

  const navItems = [
    ['today', '◷', 'Today', todayCount || ''], ['upcoming', '▦', 'Coming up', ''],
    ['all', '☷', 'This week', tasks.filter((task) => task.status !== 'Completed').length || ''],
    ['completed', '✓', 'Done', ''], ['calendar', '▦', 'Calendar', ''],
  ];

  if (loading) return <LoadingSplash />;

  return <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
    {navOpen && <AppButton className="sidebar-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon">✓</span><span className="brand-name">Spectre</span></div>
      <section className="nav-group"><div className="navgroup-title">Workspace</div>{navItems.map(([key, icon, label, count]) => <AppButton key={key} className={`navitem ${view === key ? 'active' : ''}`} onClick={() => changeView(key)}><span className="navicon">{icon}</span>{label}<span className="count">{count}</span></AppButton>)}</section>
      <section className="nav-group"><div className="navgroup-title">Folders <AppButton className="mini" title="Create folder" onClick={openFolderForm}>＋</AppButton></div>{folders.length ? folders.map((folder) => <div className="folder-row" key={folder}><AppButton className={`navitem ${view === 'folder' && selectedFolder === folder ? 'active' : ''}`} onClick={() => { setSelectedFolder(folder); setSelectedTag(''); setView('folder'); setNavOpen(false); }}><span className="navicon">▱</span>{folder}<span className="count">{tasks.filter((task) => task.folder === folder && task.status !== 'Completed').length}</span></AppButton><AppButton className="mini folder-delete" title={`Delete ${folder}`} loading={busyAction === `delete-folder-${folder}`} onClick={() => removeFolder(folder)}>×</AppButton></div>) : <AppButton className="folder-empty-action" onClick={openFolderForm}>＋ Create folder</AppButton>}</section>
      {tags.length > 0 && <section className="nav-group"><div className="navgroup-title">Tags</div>{tags.map((tag, index) => <div className="tag-row" key={tag}><AppButton className="tagline" onClick={() => { setSelectedTag(tag); setSelectedFolder(''); setView('tag'); setNavOpen(false); }}><span className={`dot dot-${index % 5}`} />{tag}</AppButton><AppButton className="mini tag-delete" title={`Delete ${tag} tag`} aria-label={`Delete ${tag} tag`} loading={busyAction === `delete-tag-${tag}`} onClick={() => removeTag(tag)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M4 7h16m-10 4v7m4-7v7M6 7l1 14h10l1-14M9 7V4h6v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg></AppButton></div>)}</section>}
      <div className="sidebar-footer">
        <AppButton className="sidebar-action" onClick={() => { setNavOpen(false); setModal('notes'); }}><span aria-hidden="true">▤</span>Notes</AppButton>
        {authUser && <AppButton ref={notificationTriggerRef} className="sidebar-action" aria-expanded={notificationsOpen} onClick={async () => { setNavOpen(false); try { setNotifications(await api('/notifications').then((result) => result.notifications || [])); setNotificationsOpen((value) => !value); } catch (err) { showFeedback('error', err.message); } }}><span aria-hidden="true">♢</span>Notifications{unreadNotificationCount > 0 && <span className="count">{unreadNotificationCount}</span>}</AppButton>}
        <AppButton className="sidebar-action" loading={busyAction === 'load-scheduled'} onClick={() => { setNavOpen(false); showScheduledActions(); }}><span aria-hidden="true">◷</span>Scheduled reminders</AppButton>
        <AppButton className="sidebar-action" onClick={() => { setNavOpen(false); setDark((value) => !value); }}><span aria-hidden="true">◐</span>{dark ? 'Light theme' : 'Dark theme'}</AppButton>
        {notificationsOpen && authUser && <section ref={notificationsRef} className="notification-panel sidebar-notification-panel" aria-label="Notifications"><div className="notification-panel-head"><strong>Notifications</strong>{unreadNotificationCount > 0 && <AppButton className="text-link" onClick={markAllNotificationsRead}>Mark all read</AppButton>}</div>{notifications.length ? notifications.map((notification) => <AppButton key={notification.id} className={`notification-item ${notification.readAt ? '' : 'unread'}`} onClick={() => { setNotificationsOpen(false); openNotification(notification); }}><strong>{notification.title}</strong><span>{notification.message}</span><small>{fmtDate(notification.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small></AppButton>) : <div className="notification-empty">You’re all caught up.</div>}</section>}
        <div className="sidebar-account"><AppButton className="account-profile" title="Open profile" onClick={() => changeView('profile')}><span className="account-avatar" aria-hidden="true">{(profileDraft.avatarUrl || authUser?.avatarUrl) ? <img src={profileDraft.avatarUrl || authUser?.avatarUrl} alt="" /> : (username || 'U').slice(0, 1).toUpperCase()}</span><span className="account-identity"><strong>{username}</strong><small>{authUser ? 'Signed in' : 'Guest account'}</small></span></AppButton>{authUser ? <AppButton className="account-signout" title="Sign out" aria-label="Sign out" onClick={() => { setNavOpen(false); setModal('signout-confirm'); }}>↪</AppButton> : <AppButton className="account-signout" title="Sign in" aria-label="Sign in" onClick={() => { setNavOpen(false); setAuthMode('signup'); setModal('auth'); }}>↗</AppButton>}</div>
      </div>
    </aside>

    <main className={`center ${mobileFiltersOpen ? 'filters-open' : ''}`}>
      <header className="topline"><AppButton className="iconbtn mobile-menu" title="Open navigation" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen((value) => !value)}>☰</AppButton><div className="top-heading"><div className="date-kicker">{fmtDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric' })}</div><h1>{viewTitle[0]}<span>{viewTitle[1]}</span></h1></div><div className="top-actions">{view !== 'profile' && <AppButton className="primary-add" onClick={() => startCreateTask()}>＋ New task</AppButton>}<AppButton className="username-button profile-chip" title="Open profile" onClick={() => changeView('profile')}><span className="profile-chip-avatar">{(profileDraft.avatarUrl || authUser?.avatarUrl) ? <img src={profileDraft.avatarUrl || authUser?.avatarUrl} alt="" /> : (username || 'U').slice(0, 1).toUpperCase()}</span><span>{username}</span></AppButton></div></header>
      <section className="progressbox"><div className="progress-icon">✳</div><div className="progress-copy"><div className="progress-title">{percentDone === 100 ? 'Beautifully done' : tasks.length - totalDone ? `${tasks.length - totalDone} ${tasks.length - totalDone === 1 ? 'task' : 'tasks'} in your hands` : 'A fresh start'}</div><div className="progress-sub">{totalDone ? `${totalDone} ${totalDone === 1 ? 'task' : 'tasks'} completed — keep going.` : 'Small steps make a meaningful day.'}</div></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percentDone}%` }} /></div><div className="progress-num">{percentDone}%</div></section>
      {view === 'profile' ? <ProfilePage username={username} authUser={authUser} profileDraft={profileDraft} setProfileDraft={setProfileDraft} onUpdate={saveProfile} onPasswordUpdate={savePassword} onAvatarChange={updateProfileImage} busyAction={busyAction} googleCalendarStatus={googleCalendarStatus} onConnectCalendar={connectGoogleCalendar} onDisconnectCalendar={disconnectGoogleCalendar} onSignIn={() => { setAuthMode('signup'); setModal('auth'); }} /> : view !== 'calendar' ? <>
        <div className="toolbar"><h2>{listTitle}</h2><div className="toolbar-actions"><TextInput className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by title" aria-label="Search tasks by title" /><AppButton className="filter-toggle" aria-expanded={mobileFiltersOpen} aria-controls="task-filters" onClick={() => setMobileFiltersOpen((open) => !open)}>Filter</AppButton></div></div>
        <div className={`filters ${mobileFiltersOpen ? 'filters-open' : ''}`} id="task-filters"><label className="sort-control">Sort<select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort tasks"><option value="manual">Manual order</option><option value="due">Due date</option><option value="priority">Priority</option><option value="created">Creation date</option><option value="alpha">Alphabetical</option></select></label><AppButton className="create-tag-btn" onClick={openTagForm}>＋ Create tag</AppButton><select aria-label="Filter status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">Any status</option>{['To Do', 'Pending', 'Acknowledged', 'In Progress', 'Completed'].map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter priority" value={filters.priority} onChange={(event) => setFilters({ ...filters, priority: event.target.value })}><option value="">Any priority</option>{['High', 'Medium', 'Low'].map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Filter tag" value={filters.tag} onChange={(event) => setFilters({ ...filters, tag: event.target.value })}><option value="">Any tag</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select><select aria-label="Filter folder" value={filters.folder} onChange={(event) => setFilters({ ...filters, folder: event.target.value })}><option value="">Any folder</option>{folders.map((folder) => <option key={folder}>{folder}</option>)}</select><select aria-label="Filter date" value={filters.date} onChange={(event) => setFilters({ ...filters, date: event.target.value })}><option value="">Any date</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="week">Next 7 days</option><option value="none">No due date</option></select></div>
        {view === 'all' && <section className="weekly-review" aria-label="Weekly summaries"><div className="weekly-review-heading"><div><h2>Weekly task view</h2><p>Showing this week’s tasks · {fmtDate(`${currentWeek.start}T12:00:00`, { month: 'short', day: 'numeric' })}–{fmtDate(`${currentWeek.end}T12:00:00`, { month: 'short', day: 'numeric' })}</p></div><strong>{completedThisWeek} completed this week</strong></div><div className="weekly-review-list"><h3>Past weekly summaries</h3>{weeklySummaries.length ? weeklySummaries.map((summary) => <article className="weekly-summary-row" key={summary.id}><div className="weekly-summary-label"><strong>{fmtDate(`${summary.weekStart}T12:00:00`, { month: 'short', day: 'numeric' })}–{fmtDate(`${summary.weekEnd}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' })}</strong><span>{summary.tasks.length} task{summary.tasks.length === 1 ? '' : 's'} completed</span></div><div className="weekly-summary-actions"><AppButton className="text-link" onClick={() => openWeeklySummary(summary)}>View summary</AppButton><AppButton className="secondary-button" onClick={() => exportWeeklySummary(summary, username, 'word')}>Word document</AppButton><AppButton className="secondary-button" onClick={() => exportWeeklySummary(summary, username, 'excel')}>Excel workbook</AppButton></div></article>) : <p className="weekly-summary-empty">Your first weekly report will appear here after this week ends.</p>}</div></section>}
        <section className="task-list" aria-label="Tasks">{loading ? <div className="empty">Loading your tasks…</div> : error ? <div className="empty"><strong>Could not load Spectre</strong><span>{error}</span><AppButton className="save-task" onClick={reload}>Retry</AppButton></div> : visibleTasks.length ? visibleTasks.map((task) => <TaskCard key={task.id} task={task} onToggle={toggleTask} onEdit={() => editTask(task)} onOpen={() => setSelectedTask(task)} onDrop={moveTask} />) : <div className="empty"><strong>{search ? 'No matching tasks' : view === 'folder' ? 'This folder is empty' : view === 'tag' ? 'No tasks use this tag yet' : view === 'completed' ? 'No completed tasks yet' : view === 'all' ? 'No tasks planned for this week' : 'No tasks to show'}</strong><span>{view === 'folder' ? 'Create a task in this folder to get started.' : view === 'tag' ? 'Create a task with this tag to get started.' : search ? 'Clear your search or add a new task.' : view === 'all' ? 'Add this week’s tasks here. Later tasks remain in Upcoming.' : 'Add a task whenever you’re ready.'}</span><div className="empty-actions"><AppButton className="save-task" onClick={() => startCreateTask({ folder: view === 'folder' ? selectedFolder : '', tag: view === 'tag' ? selectedTag : '' })}>Create task</AppButton></div></div>}</section>
      </> : <CalendarView tasks={tasks} googleEvents={googleCalendarEvents} month={month} setMonth={setMonth} selectedDay={selectedDay} setSelectedDay={setSelectedDay} onDrop={moveTask} onCreate={(day = selectedDay) => { setSelectedDay(day); setMonth(new Date(`${day}T12:00:00`)); startCreateTask({ start: day, due: `${day}T09:00` }); }} onOpen={setSelectedTask} onToggle={toggleTask} onEdit={editTask} />}
    </main>

    <aside className={`notes-drawer ${modal === 'notes' ? 'open' : ''}`}><div className="drawer-head"><h2>Notes</h2><AppButton className="iconbtn" aria-label="Close notes" onClick={() => setModal(null)}>×</AppButton></div><AppButton className="add-inline" onClick={() => { setNoteDraft({ title: '', text: '' }); setNoteFormat('bullets'); setNoteEditId(null); setModal('note'); }}>＋ Write a note</AppButton>{notes.length ? notes.map((note) => <article className="note-card" key={note.id}><div className="note-top"><strong>{note.title || 'Quick note'}</strong><div><AppButton className="note-del" title="Edit note" onClick={() => editNote(note)}>✎</AppButton><AppButton className="note-del" title="Delete note" loading={busyAction === `delete-note-${note.id}`} onClick={() => removeNote(note)}>×</AppButton></div></div><div className="note-date">{fmtDate(note.createdAt)}</div><p>{note.text}</p></article>) : <div className="empty mini-empty"><strong>No notes yet</strong><span>Write a note to keep an idea handy.</span><AppButton className="save-task" onClick={() => { setNoteDraft({ title: '', text: '' }); setNoteFormat('bullets'); setNoteEditId(null); setModal('note'); }}>Create note</AppButton></div>}</aside>

    <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} authUser={authUser} onRequireAuth={() => { setAssistantOpen(true); setAuthMode('signup'); setAuthDraft({ email: '', password: '' }); setModal('auth'); }} onCompleted={async () => { await reload(); showFeedback('success', 'Reminder created.'); }} onShowScheduledActions={showScheduledActions} />
    {modal === 'task' && taskDraft && <Modal title={editingId ? 'Edit task' : 'New task'} onClose={() => setModal(null)}><form className="task-form" onSubmit={saveTask}>
      <label className="field full">Task title *<TextInput required maxLength="140" value={taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} placeholder="What needs to get done?" /></label><p className="field-hint">You can also write: “Remind Michael at 4 PM today to complete the design.”</p>
      <div className="form-grid"><label className="field">Due date *<TextInput type="date" required value={taskDraft.due?.slice(0, 10) || ''} onChange={(event) => { const time = taskDraft.due?.slice(11, 16) || '17:00'; setTaskDraft({ ...taskDraft, due: event.target.value ? `${event.target.value}T${time}` : '' }); }} /></label><label className="field">Due time *<TextInput type="time" required value={taskDraft.due?.slice(11, 16) || ''} onChange={(event) => { const date = taskDraft.due?.slice(0, 10) || localToday(); setTaskDraft({ ...taskDraft, due: `${date}T${event.target.value}` }); }} /></label><label className="field">Progress *<select value={taskDraft.status} onChange={(event) => setTaskDraft({ ...taskDraft, status: event.target.value })}>{['To Do', 'In Progress', 'Completed'].map((item) => <option key={item}>{item}</option>)}</select></label><label className="field">Priority *<select value={taskDraft.priority} onChange={(event) => setTaskDraft({ ...taskDraft, priority: event.target.value })}>{['High', 'Medium', 'Low'].map((item) => <option key={item}>{item}</option>)}</select></label></div>
      <details className="optional-details" open={Boolean(editingId && (taskDraft.description || taskDraft.folder || taskDraft.tags || taskDraft.notes || taskDraft.recurrence || taskDraft.reminder || taskDraft.emailReminder || taskDraft.remindSomeone || taskDraft.subtasks?.length || taskDraft.attachments?.length))}><summary>＋ More details (optional)</summary><p className="field-hint optional-hint">Add a description, folder, alert, checklist, attachment, or note if it helps.</p><div className="form-grid"><label className="field full">Description<textarea rows="3" value={taskDraft.description || ''} onChange={(event) => setTaskDraft({ ...taskDraft, description: event.target.value })} /></label><label className="field">Folder<select value={taskDraft.folder || ''} onChange={(event) => setTaskDraft({ ...taskDraft, folder: event.target.value })}><option value="">No folder</option>{folders.map((folder) => <option key={folder}>{folder}</option>)}</select></label><label className="field">Tags, separated by commas<TextInput value={taskDraft.tags} onChange={(event) => setTaskDraft({ ...taskDraft, tags: event.target.value })} /></label><label className="field">Repeat task<select value={taskDraft.recurrence || ''} onChange={(event) => setTaskDraft({ ...taskDraft, recurrence: event.target.value })}><option value="">Does not repeat</option>{['Daily', 'Weekly', 'Monthly'].map((item) => <option key={item}>{item}</option>)}</select></label><label className="field">Pop-up alert<select value={taskDraft.reminder || ''} onChange={(event) => setTaskDraft({ ...taskDraft, reminder: event.target.value })}><option value="">No reminder</option><option value="at-due">At due time</option><option value="10">10 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option></select></label><div className="field full external-reminder-setting"><label className="reminder-check"><TextInput type="checkbox" checked={Boolean(taskDraft.remindSomeone)} onChange={(event) => setTaskDraft({ ...taskDraft, remindSomeone: event.target.checked })} /> Remind someone about this task</label>{taskDraft.remindSomeone && <div className="reminder-methods" aria-label="Reminder methods"><AppButton type="button" className="reminder-method" disabled><span className="reminder-method-icon" aria-hidden="true">✉</span><span className="reminder-method-copy"><strong>Email reminder</strong><small>Send a scheduled email reminder.</small></span><span className="coming-soon-badge">Coming soon</span></AppButton><AppButton type="button" className="reminder-method" disabled><span className="reminder-method-icon" aria-hidden="true">☎</span><span className="reminder-method-copy"><strong>Phone reminder</strong><small>Automatically call someone to remind them.</small></span><span className="coming-soon-badge">Coming soon</span></AppButton></div>}</div><label className="field full">Checklist<div className="inline-add"><TextInput value={subtaskText} onChange={(event) => setSubtaskText(event.target.value)} placeholder="Add checklist item" /><AppButton type="button" className="iconbtn" onClick={() => { if (subtaskText.trim()) { setTaskDraft({ ...taskDraft, subtasks: [...(taskDraft.subtasks || []), { text: subtaskText.trim(), done: false }] }); setSubtaskText(''); } }}>＋</AppButton></div><div className="chip-list">{(taskDraft.subtasks || []).map((item, index) => <AppButton type="button" className="chip" key={`${item.text}-${index}`} onClick={() => setTaskDraft({ ...taskDraft, subtasks: taskDraft.subtasks.filter((_, i) => i !== index) })}>{item.text} ×</AppButton>)}</div></label><label className="field full">Attachments<TextInput type="file" multiple onChange={(event) => setAttachmentFiles([...attachmentFiles, ...[...event.target.files].map((file) => ({ name: file.name, size: file.size, type: file.type }))])} /><div className="chip-list">{attachmentFiles.map((file, index) => <AppButton type="button" className="chip" key={`${file.name}-${index}`} onClick={() => setAttachmentFiles(attachmentFiles.filter((_, i) => i !== index))}>{file.name} ×</AppButton>)}</div></label><label className="field full">Task notes<textarea rows="3" value={taskDraft.notes || ''} onChange={(event) => setTaskDraft({ ...taskDraft, notes: event.target.value })} /></label></div></details>
      <div className="modal-actions">{editingId && <AppButton type="button" className="delete-task" onClick={() => { const task = tasks.find((item) => item.id === editingId); if (task) deleteTask(task); }}>Delete task</AppButton>}<AppButton className="save-task" loading={busyAction === 'save-task'}>{busyAction === 'save-task' ? 'Saving…' : 'Save task'}</AppButton></div></form></Modal>}
    {modal === 'confirmation' && confirmation && <Modal title={confirmation.title} onClose={() => { setConfirmation(null); setModal(null); }}><p className="auth-copy">{confirmation.message}</p><div className="modal-actions auth-actions"><AppButton className="secondary-button" onClick={() => { setConfirmation(null); setModal(null); }}>Cancel</AppButton><AppButton className="delete-series-button" loading={busyAction.startsWith('delete-')} onClick={confirmRequestedAction}>{confirmation.confirmLabel || 'Confirm'}</AppButton></div></Modal>}
    {modal === 'delete-recurring' && deleteTarget && <Modal title="Delete recurring task" onClose={() => { setModal(null); setDeleteTarget(null); }}><p className="auth-copy">Delete only this occurrence, or remove every task in the “{deleteTarget.recurrence}” series?</p><div className="delete-recurring-actions"><AppButton className="secondary-button" loading={busyAction === `delete-${deleteTarget.id}`} onClick={() => performDeleteTask(deleteTarget, false)}>Delete this task</AppButton><AppButton className="delete-series-button" loading={busyAction === `delete-${deleteTarget.id}`} onClick={() => performDeleteTask(deleteTarget, true)}>Delete all in series</AppButton></div></Modal>}
    {modal === 'calendar-conflict' && <Modal title="Calendar time conflict" onClose={() => { setModal('task'); setCalendarConflicts([]); setPendingTaskPayload(null); }}><p className="auth-copy">This task is close to an event in your Google Calendar. Do you want to create it anyway?</p><div className="calendar-conflict-list">{calendarConflicts.slice(0, 4).map((event) => <div className="calendar-conflict-item" key={event.id}><strong>{event.title}</strong><span>{event.allDay ? fmtDate(event.start, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · All day' : `${fmtDate(event.start, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – ${fmtDate(event.end, { hour: 'numeric', minute: '2-digit' })}`}</span></div>)}</div><div className="modal-actions auth-actions"><AppButton className="secondary-button" onClick={() => { setModal('task'); setCalendarConflicts([]); setPendingTaskPayload(null); }}>Cancel</AppButton><AppButton className="save-task" loading={busyAction === 'save-task'} onClick={confirmCalendarConflict}>Create task anyway</AppButton></div></Modal>}    {modal === 'auth' && <Modal title={authMode === 'signup' ? 'Create your account' : 'Log in'} onClose={() => { if (pendingReminder) setPendingReminder(null); setModal(null); }}><p className="auth-copy">{pendingReminder ? 'Sign in to continue with your email reminder. Your task is saved.' : 'Use your email and password to access scheduled actions.'}</p><AppButton type="button" className="google-auth-button" loading={busyAction === 'google-auth'} disabled={!googleAuthReady} onClick={startGoogleSignIn}><GoogleMark />{busyAction === 'google-auth' ? 'Connecting…' : 'Continue with Google'}</AppButton>{!googleAuthReady && <small className="google-auth-hint">Google sign-in is not ready yet. You can still use your email and password.</small>}<div className="auth-divider"><span>or use email</span></div><form className="task-form" onSubmit={authenticate}><label className="field">Email<TextInput required type="email" autoComplete="email" value={authDraft.email} onChange={(event) => setAuthDraft({ ...authDraft, email: event.target.value })} /></label><PasswordField label="Password" required minLength={authMode === 'signup' ? 8 : undefined} autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} value={authDraft.password} onChange={(event) => setAuthDraft({ ...authDraft, password: event.target.value })} /><div className="modal-actions auth-actions"><AppButton className="save-task" loading={busyAction === 'auth'}>{busyAction === 'auth' ? 'Please wait…' : authMode === 'signup' ? 'Sign up' : 'Log in'}</AppButton><AppButton type="button" className="secondary-button" onClick={() => setAuthMode(authMode === 'signup' ? 'login' : 'signup')}>{authMode === 'signup' ? 'I have an account' : 'Create account'}</AppButton></div></form>{authMode === 'login' && <AppButton className="text-link" onClick={() => { setPasswordResetEmail(authDraft.email); setModal('forgot-password'); }}>Forgot password?</AppButton>}</Modal>}
    {modal === 'forgot-password' && <Modal title="Reset your password" onClose={() => setModal('auth')}><p className="auth-copy">Enter your account email. If it matches an account, we’ll send a reset link.</p><form className="task-form" onSubmit={requestPasswordReset}><label className="field">Email<TextInput required type="email" autoComplete="email" value={passwordResetEmail} onChange={(event) => setPasswordResetEmail(event.target.value)} /></label><div className="modal-actions auth-actions"><AppButton type="button" className="secondary-button" onClick={() => setModal('auth')}>Back to log in</AppButton><AppButton className="save-task" loading={busyAction === 'password-reset-request'}>{busyAction === 'password-reset-request' ? 'Sending…' : 'Send reset link'}</AppButton></div></form></Modal>}
    {modal === 'password-reset' && <Modal title="Choose a new password" onClose={() => { setPasswordResetToken(''); window.history.replaceState({}, '', window.location.pathname); setModal('auth'); }}><p className="auth-copy">This reset link expires after one hour and can only be used once.</p><form className="task-form" onSubmit={completePasswordReset}><PasswordField label="New password" required minLength="8" autoComplete="new-password" value={passwordResetPassword} onChange={(event) => setPasswordResetPassword(event.target.value)} /><div className="modal-actions auth-actions"><AppButton className="save-task" loading={busyAction === 'password-reset-complete'}>{busyAction === 'password-reset-complete' ? 'Updating…' : 'Update password'}</AppButton></div></form></Modal>}
    {modal === 'guest-transfer' && <Modal title="Transfer your guest tasks?" onClose={() => finishGuestTransition(false)}><p className="auth-copy">This device has {guestTransferSummary?.tasks || 0} task{guestTransferSummary?.tasks === 1 ? '' : 's'} and {guestTransferSummary?.notes || 0} note{guestTransferSummary?.notes === 1 ? '' : 's'} saved as a guest. You can merge them into this account. Existing account data stays intact and matching tasks are skipped.</p><div className="modal-actions auth-actions"><AppButton className="secondary-button" loading={busyAction === 'finish-signin'} onClick={() => finishGuestTransition(false)}>Keep separate</AppButton><AppButton className="save-task" loading={busyAction === 'guest-transfer'} onClick={() => finishGuestTransition(true)}>Transfer guest data</AppButton></div></Modal>}
    {modal === 'recipient' && pendingReminder && <Modal title="Who should receive this reminder?" onClose={cancelPendingReminder}><p className="auth-copy">Your task is saved. Add the recipient name and email to schedule this reminder.</p><form className="task-form" onSubmit={continueToConfirmation}><label className="field">Name<TextInput required maxLength="200" value={recipientDraft.name} onChange={(event) => setRecipientDraft({ ...recipientDraft, name: event.target.value })} placeholder="Michael" /></label><label className="field">Email<TextInput required type="email" value={recipientDraft.email} onChange={(event) => setRecipientDraft({ ...recipientDraft, email: event.target.value })} placeholder="name@example.com" /></label><div className="modal-actions"><AppButton type="button" className="secondary-button" onClick={cancelPendingReminder}>Cancel reminder</AppButton><AppButton className="save-task">Continue</AppButton></div></form></Modal>}
    {modal === 'reminder-confirm' && pendingReminder && <Modal title="Confirm email reminder" onClose={() => setModal('recipient')}><div className="reminder-summary"><strong>{pendingReminder.recipientName}</strong><span>{pendingReminder.recipientEmail}</span><p>{pendingReminder.message}</p><span>{fmtDate(pendingReminder.scheduledAt, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div><div className="modal-actions"><AppButton className="secondary-button" onClick={() => setModal('recipient')}>Edit recipient</AppButton><AppButton className="save-task" loading={busyAction === 'schedule-reminder'} onClick={scheduleReminder}>{busyAction === 'schedule-reminder' ? 'Scheduling…' : 'Schedule reminder'}</AppButton></div></Modal>}
    {modal === 'weekly-summary' && activeWeeklySummary && <Modal title="Your weekly summary" className="weekly-summary-modal" onClose={closeWeeklySummary}><p className="weekly-summary-period">{fmtDate(`${activeWeeklySummary.weekStart}T12:00:00`, { month: 'long', day: 'numeric', year: 'numeric' })}–{fmtDate(`${activeWeeklySummary.weekEnd}T12:00:00`, { month: 'long', day: 'numeric', year: 'numeric' })}</p><p className="weekly-summary-intro">{activeWeeklySummary.tasks.length ? `You completed ${activeWeeklySummary.tasks.length} task${activeWeeklySummary.tasks.length === 1 ? '' : 's'} this week. Here’s a record of what you accomplished.` : 'You completed no tasks this week. Your weekly report is ready whenever you need it.'}</p>{activeWeeklySummary.tasks.length > 0 && <ol className="weekly-summary-task-list">{activeWeeklySummary.tasks.map((task) => <li key={task.id}><strong>{task.title}</strong>{task.description && <span>{task.description}</span>}<small>{task.priority}{task.folder ? ` · ${task.folder}` : ''}{task.completedAt ? ` · Completed ${fmtDate(task.completedAt, { month: 'short', day: 'numeric' })}` : ''}</small></li>)}</ol>}<div className="weekly-summary-export"><AppButton className="secondary-button" onClick={() => exportWeeklySummary(activeWeeklySummary, username, 'word')}>Download Word document</AppButton><AppButton className="secondary-button" onClick={() => exportWeeklySummary(activeWeeklySummary, username, 'excel')}>Download Excel workbook (.xlsx)</AppButton><AppButton className="save-task" loading={busyAction === `view-week-${activeWeeklySummary.id}`} onClick={closeWeeklySummary}>Done</AppButton></div></Modal>}
    {modal === 'scheduled-actions' && <Modal title="Scheduled reminders" onClose={() => setModal(null)}>{scheduledActions.length ? <div className="scheduled-list">{scheduledActions.map((action) => <article className="note-card scheduled-reminder-card" key={action.id}><div className="note-top"><strong>Reminder to {action.recipientName}</strong><span className={`pill status status-${action.status}`}>{deliveryStatusLabel(action.status)}</span></div><p><strong>Recipient:</strong> {action.recipientEmail}</p><p><strong>Message:</strong> {action.message}</p><div className="note-date"><strong>Scheduled:</strong> {fmtDate(action.scheduledAt, { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} · {action.timezone}</div><p><strong>Email:</strong> {action.status === 'sent' || action.status === 'completed' ? `Accepted by provider${action.emailSentAt ? ` · ${fmtDate(action.emailSentAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}` : deliveryStatusLabel(action.status)}</p><p><strong>Reply:</strong> {action.acknowledgedAt ? `Acknowledged · ${fmtDate(action.acknowledgedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Not acknowledged'}</p><p><strong>Task:</strong> {action.taskStatus || (action.taskId ? 'Unavailable' : 'No linked task')}</p>{action.failureReason && <p className="failure-reason">{userFacingFeedback(action.failureReason)}{action.attemptCount ? ` (attempt ${action.attemptCount})` : ''}</p>}{(action.status === 'scheduled' || action.status === 'failed') && <div className="scheduled-actions-buttons">{action.status === 'scheduled' && <AppButton className="secondary-button" loading={busyAction === `cancel-action-${action.id}`} onClick={() => cancelScheduledAction(action)}>Cancel reminder</AppButton>}<AppButton className="secondary-button" loading={busyAction === `revoke-link-${action.id}`} onClick={() => revokeReminderLink(action)}>Revoke guest link</AppButton></div>}</article>)}</div> : <div className="empty"><strong>No scheduled reminders yet</strong><span>Reminders you create will appear here.</span></div>}</Modal>}
    {modal === 'signout-confirm' && <Modal title="Sign out?" onClose={() => setModal(null)}><p className="auth-copy">You can continue using Spectre as a guest on this device.</p><div className="modal-actions auth-actions"><AppButton className="secondary-button" onClick={() => setModal(null)}>Cancel</AppButton><AppButton className="save-task" loading={busyAction === 'sign-out'} onClick={signOut}>{busyAction === 'sign-out' ? 'Signing out…' : 'Sign out'}</AppButton></div></Modal>}
    {modal === 'feedback' && <Modal title={feedback.title} onClose={() => setModal(null)}><p className={`feedback-copy ${feedback.kind}`}>{feedback.message}</p><div className="modal-actions auth-actions"><AppButton className="save-task" onClick={() => setModal(null)}>Done</AppButton></div></Modal>}
    {dueAlert && <Modal title="Task due now" onClose={() => setDueAlert(null)}><div className="due-alert"><strong>{dueAlert.title}</strong>{dueAlert.description && <p>{dueAlert.description}</p>}<span>Due {fmtDate(dueAlert.due, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div><div className="modal-actions auth-actions"><AppButton className="secondary-button" onClick={() => setDueAlert(null)}>Dismiss</AppButton><AppButton className="save-task" onClick={() => { setSelectedTask(dueAlert); setDueAlert(null); }}>View task</AppButton></div></Modal>}
    {modal === 'folder' && <Modal title="Create folder" onClose={() => setModal(null)}><form onSubmit={createFolder}><label className="field">Folder name<TextInput required autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="e.g. Home" /></label><div className="modal-actions"><AppButton className="save-task" loading={busyAction === 'create-folder'}>{busyAction === 'create-folder' ? 'Creating…' : 'Create folder'}</AppButton></div></form></Modal>}
    {modal === 'tag' && <Modal title="Create tag" onClose={() => setModal(null)}><form onSubmit={createTag}><label className="field">Tag name<TextInput required autoFocus value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="e.g. Focus" /></label><div className="modal-actions"><AppButton className="save-task" loading={busyAction === 'create-tag'}>{busyAction === 'create-tag' ? 'Creating…' : 'Create tag'}</AppButton></div></form></Modal>}
    {modal === 'username' && <Modal title="Your username" onClose={() => setModal(null)}><form onSubmit={changeUsername}><label className="field">Username<TextInput required maxLength="80" autoFocus value={usernameDraft} onChange={(event) => setUsernameDraft(event.target.value)} /></label><div className="modal-actions"><AppButton className="save-task" loading={busyAction === 'username'}>{busyAction === 'username' ? 'Saving…' : 'Update'}</AppButton></div></form></Modal>}
    {modal === 'note' && <Modal title={noteEditId ? 'Edit note' : 'New note'} onClose={() => { setModal(null); setNoteEditId(null); }}><form onSubmit={addNote}><label className="field">Title (optional)<TextInput value={noteDraft.title} onChange={(event) => setNoteDraft({ ...noteDraft, title: event.target.value })} placeholder="e.g. Biology lecture — cell structure" /></label><div className="note-dictation-heading"><label className="field">Arrange as<select value={noteFormat} onChange={(event) => { const format = event.target.value; setNoteFormat(format); if (noteDraft.text.trim()) void rearrangeNote(format, 'format'); }} aria-label="Dictation format"><option value="bullets">Bullet points</option><option value="paragraphs">Paragraphs</option></select></label><span>Keep speaking through pauses. Spectre won’t interrupt or ask questions.</span></div><VoiceTextArea dictationRef={noteDictationRef} required rows="10" value={noteDraft.text} format={noteFormat} onChange={(text) => setNoteDraft({ ...noteDraft, text })} /><div className="note-editor-actions"><AppButton type="button" className="secondary-button" loading={busyAction === 'note-rewrite'} disabled={!noteDraft.text.trim()} onClick={() => rearrangeNote(noteFormat, 'polish')}>✦ Rearrange with AI</AppButton><AppButton className="save-task" loading={busyAction === 'save-note'}>{busyAction === 'save-note' ? 'Saving…' : noteEditId ? 'Save changes' : 'Save note'}</AppButton></div></form></Modal>}
    {selectedTask && <TaskDetail task={selectedTask} deleting={busyAction === `delete-${selectedTask.id}`} toggling={busyAction === `toggle-${selectedTask.id}`} savingSubtask={busyAction === `subtask-${selectedTask.id}`} onClose={() => setSelectedTask(null)} onEdit={() => editTask(selectedTask)} onToggle={() => toggleTask(selectedTask)} onSubtask={async (index) => { const subtasks = selectedTask.subtasks.map((item, i) => i === index ? { ...item, done: !item.done } : item); setBusyAction(`subtask-${selectedTask.id}`); try { const response = await api(`/tasks/${selectedTask.id}`, { method: 'PATCH', body: { subtasks } }); setSelectedTask(response.task); await reload(); } catch (err) { showFeedback('error', err.message); } finally { setBusyAction(''); } }} onDelete={() => deleteTask(selectedTask)} />}
    {!assistantOpen && <AppButton className="assistant-fab" aria-label="Open Spectre Assistant" title="Open Spectre Assistant" onClick={() => setAssistantOpen(true)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42m-9.88 9.88-1.42 1.42" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" stroke="currentColor" strokeWidth="1.7"/></svg><span className="assistant-fab-label">Ask Spectre</span></AppButton>}
    {toast && <div className="toast">{toast}</div>}
  </div>;
}

const AppButton = React.forwardRef(({ className = '', loading = false, disabled = false, children, ...props }, ref) => <button ref={ref} className={`app-button ${className}`} {...props} disabled={loading || disabled} aria-busy={loading || undefined}>{loading && <span className="button-spinner" aria-hidden="true" />}{children}</button>);
const TextInput = ({ className = '', ...props }) => <input className={`app-input ${className}`} {...props} />;
function GoogleMark() { return <svg className="google-mark" aria-hidden="true" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.73 7.18l7.66 5.94c4.47-4.13 7.11-10.22 7.11-17.59Z"/><path fill="#FBBC05" d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.19a23.9 23.9 0 0 0 0 21.56l7.98-6.19Z"/><path fill="#34A853" d="M24 48c6.47 0 11.91-2.13 15.87-5.86l-7.66-5.94c-2.13 1.43-4.86 2.27-8.21 2.27-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>; }

function AssistantPanel({ open, onClose, authUser, onRequireAuth, onCompleted, onShowScheduledActions }) {
  const latestPropsRef = React.useRef({ authUser, onRequireAuth, onCompleted, onShowScheduledActions });
  latestPropsRef.current = { authUser, onRequireAuth, onCompleted, onShowScheduledActions };
  const openRef = React.useRef(open);
  openRef.current = open;
  const restore = () => { try { return JSON.parse(sessionStorage.getItem('spectre.voice-assistant-session') || '{}'); } catch { return {}; } };
  const saved = useMemo(restore, []);
  const [messages, setMessages] = useState(Array.isArray(saved.messages) ? saved.messages : [{ role: 'assistant', content: 'Hi, I’m Spectre. Tell me what you’d like to remember, or ask me to email someone a reminder.' }]);
  const [draft, setDraft] = useState(saved.draft || null);
  const messagesRef = React.useRef(messages);
  const draftRef = React.useRef(draft);
  messagesRef.current = messages;
  draftRef.current = draft;
  const [transcript, setTranscript] = useState('');
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [recognitionAvailable, setRecognitionAvailable] = useState(false);
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  const recognitionRef = React.useRef(null);
  const listeningSessionRef = React.useRef(false);
  const voiceTurnPendingRef = React.useRef(false);
  const finalTranscriptRef = React.useRef('');
  const voiceTurnTimerRef = React.useRef(null);
  const interpretationAbortRef = React.useRef(null);
  const activeExecutionIdRef = React.useRef(null);
  const cancelledExecutionIdsRef = React.useRef(new Set());
  const [manual, setManual] = useState(false);
  const [manualType, setManualType] = useState('personal_reminder');

  useEffect(() => { sessionStorage.setItem('spectre.voice-assistant-session', JSON.stringify({ messages: messages.slice(-30), draft })); }, [messages, draft]);
  useEffect(() => { setRecognitionAvailable(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)); }, []);
  useEffect(() => {
    if (open) return;
    listeningSessionRef.current = false; voiceTurnPendingRef.current = false;
    setVoiceSessionActive(false); setPhase('waiting'); window.clearTimeout(voiceTurnTimerRef.current);
    recognitionRef.current?.abort?.(); recognitionRef.current = null;
    finalTranscriptRef.current = ''; setTranscript('');
    window.speechSynthesis?.cancel();
    interpretationAbortRef.current?.abort(); interpretationAbortRef.current = null;
    if (activeExecutionIdRef.current) cancelledExecutionIdsRef.current.add(activeExecutionIdRef.current);
  }, [open]);
  useEffect(() => () => { listeningSessionRef.current = false; window.clearTimeout(voiceTurnTimerRef.current); recognitionRef.current?.abort?.(); window.speechSynthesis?.cancel(); }, []);

  function resumeVoiceConversation() {
    if (!listeningSessionRef.current || recognitionRef.current) return;
    window.setTimeout(() => {
      if (listeningSessionRef.current && !recognitionRef.current) startRecognition();
    }, 250);
  }
  function speak(text) {
    if (muted || !window.speechSynthesis || !window.SpeechSynthesisUtterance) { resumeVoiceConversation(); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const language = (navigator.language || 'en').split('-')[0].toLowerCase();
    const voices = window.speechSynthesis.getVoices();
    const matchingVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language));
    utterance.voice = matchingVoices.find((voice) => /natural|neural|enhanced|premium/i.test(voice.name)) || matchingVoices.find((voice) => /google|microsoft/i.test(voice.name)) || matchingVoices[0] || null;
    utterance.lang = utterance.voice?.lang || navigator.language || 'en-US';
    utterance.rate = 0.96;
    utterance.pitch = 1;
    utterance.onstart = () => setPhase('speaking');
    utterance.onend = () => { setPhase('waiting'); resumeVoiceConversation(); };
    utterance.onerror = () => { setPhase('waiting'); resumeVoiceConversation(); };
    window.speechSynthesis.speak(utterance);
  }
  function addAssistant(text) {
    const nextMessages = [...messagesRef.current, { role: 'assistant', content: text }];
    messagesRef.current = nextMessages; setMessages(nextMessages); speak(text);
  }
  async function interpret(text) {
    const clean = text.trim(); if (!clean || !openRef.current) return;
    setError(''); setManual(false); setPhase('processing');
    const currentDraft = draftRef.current;
    const nextMessages = [...messagesRef.current, { role: 'user', content: clean }];
    messagesRef.current = nextMessages; setMessages(nextMessages);
    const controller = new AbortController();
    interpretationAbortRef.current?.abort(); interpretationAbortRef.current = controller;
    try {
      const result = await api('/assistant/interpret', { method: 'POST', signal: controller.signal, body: { transcript: clean, messages: nextMessages.slice(-8), currentDraft, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      if (controller.signal.aborted || !openRef.current) return;
      draftRef.current = result.draft || null; setDraft(draftRef.current);
      if (result.intent === 'cancel') { draftRef.current = null; setDraft(null); addAssistant(result.assistantText); }
      else if (result.intent === 'confirm' && result.ready && result.draft) { draftRef.current = result.draft; setDraft(result.draft); addAssistant(result.draft.actionType === 'schedule_email' && !latestPropsRef.current.authUser ? 'That email reminder needs an account. Sign in or create one, then confirm it to schedule.' : 'Confirmed. I’m creating your reminder now.'); await execute(result.draft); }
      else addAssistant(result.assistantText || 'What would you like me to change?');
      setPhase(result.ready ? 'waiting' : 'waiting');
    } catch (err) { if (controller.signal.aborted || !openRef.current) return; setError(err.message); setPhase('error'); addAssistant(`I couldn’t process that: ${err.message}`); }
    finally { if (interpretationAbortRef.current === controller) interpretationAbortRef.current = null; }
  }
  function startRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setError('Voice recognition is not available in this browser. Type your request below.'); return; }
    if (!listeningSessionRef.current || recognitionRef.current) return;
    finalTranscriptRef.current = '';
    const recognition = new SpeechRecognition(); recognitionRef.current = recognition; recognition.continuous = true; recognition.interimResults = true; recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event) => {
      let finalText = ''; let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) { if (event.results[i].isFinal) finalText += event.results[i][0].transcript; else interim += event.results[i][0].transcript; }
      if (finalText.trim()) {
        finalTranscriptRef.current += `${finalTranscriptRef.current ? ' ' : ''}${finalText.trim()}`;
        window.clearTimeout(voiceTurnTimerRef.current);
        voiceTurnTimerRef.current = window.setTimeout(() => {
          if (!listeningSessionRef.current || !finalTranscriptRef.current.trim()) return;
          voiceTurnPendingRef.current = true;
          recognitionRef.current?.stop();
        }, 1250);
      }
      setTranscript(`${finalTranscriptRef.current}${interim ? `${finalTranscriptRef.current ? ' ' : ''}${interim}` : ''}`);
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      listeningSessionRef.current = false; voiceTurnPendingRef.current = false; setVoiceSessionActive(false);
      setPhase('error'); setError(event.error === 'not-allowed' ? 'Microphone permission was denied. You can type your request instead.' : `Voice input stopped (${event.error}). You can type your request instead.`);
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (voiceTurnPendingRef.current || listeningSessionRef.current && finalTranscriptRef.current.trim()) {
        window.clearTimeout(voiceTurnTimerRef.current);
        voiceTurnPendingRef.current = false;
        const text = finalTranscriptRef.current.trim(); finalTranscriptRef.current = '';
        setTranscript('');
        if (text) void interpret(text);
        else if (listeningSessionRef.current) resumeVoiceConversation();
      } else if (listeningSessionRef.current) resumeVoiceConversation();
      else setPhase('waiting');
    };
    try { recognition.start(); setPhase('listening'); }
    catch { recognitionRef.current = null; listeningSessionRef.current = false; setPhase('error'); setError('Could not start voice input. Type your request instead.'); }
  }
  function startListening() {
    window.speechSynthesis?.cancel(); listeningSessionRef.current = true; setVoiceSessionActive(true); voiceTurnPendingRef.current = false;
    finalTranscriptRef.current = ''; setTranscript(''); setError(''); setPhase('listening'); startRecognition();
  }
  function stopListening() {
    listeningSessionRef.current = false; setVoiceSessionActive(false); window.clearTimeout(voiceTurnTimerRef.current);
    voiceTurnPendingRef.current = Boolean(finalTranscriptRef.current.trim());
    if (recognitionRef.current) recognitionRef.current.stop();
    else if (voiceTurnPendingRef.current) { const text = finalTranscriptRef.current.trim(); finalTranscriptRef.current = ''; voiceTurnPendingRef.current = false; setTranscript(''); void interpret(text); }
    else setPhase('waiting');
  }
  function interrupt() { window.speechSynthesis?.cancel(); setPhase('waiting'); resumeVoiceConversation(); }
  async function execute(actionDraft) {
    if (!openRef.current) return;
    if (actionDraft.actionType === 'schedule_email' && !latestPropsRef.current.authUser) { setPhase('waiting'); addAssistant('This reminder needs an account. Your draft is saved here. Sign in or create an account, then confirm it to schedule.'); latestPropsRef.current.onRequireAuth(); return; }
    setPhase('executing'); setError(''); activeExecutionIdRef.current = actionDraft.draftId;
    try {
      let created;
      if (actionDraft.actionType === 'personal_reminder') {
        created = await api('/tasks', { method: 'POST', body: { assistantDraftId: actionDraft.draftId, title: actionDraft.title || actionDraft.message, description: actionDraft.message || '', start: actionDraft.scheduledDate, due: new Date(`${actionDraft.scheduledDate}T${actionDraft.scheduledTime}`).toISOString(), status: 'To Do', priority: 'Medium', reminder: 'at-due', emailReminder: false, tags: [], subtasks: [], attachments: [], notes: '', folder: '', recurrence: '' } });
      } else {
        created = await api('/scheduled-actions', { method: 'POST', body: { clientRequestId: actionDraft.draftId, taskId: null, recipientName: actionDraft.recipientName, recipientEmail: actionDraft.recipientEmail, subject: `Reminder: ${actionDraft.message.slice(0, 120)}`, message: actionDraft.message, scheduledAt: new Date(`${actionDraft.scheduledDate}T${actionDraft.scheduledTime}`).toISOString(), timezone: actionDraft.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, confirmed: true } });
      }
      if (!openRef.current || cancelledExecutionIdsRef.current.has(actionDraft.draftId)) {
        try {
          if (actionDraft.actionType === 'personal_reminder' && created?.id) await api(`/tasks/${created.id}`, { method: 'DELETE' });
          else if (actionDraft.actionType === 'schedule_email' && created?.id) await api(`/scheduled-actions/${created.id}/cancel`, { method: 'POST' });
        } catch (cancelError) { console.error('[Spectre] Could not cancel the assistant action after its modal closed:', cancelError); }
        cancelledExecutionIdsRef.current.delete(actionDraft.draftId);
        return;
      }
      activeExecutionIdRef.current = null;
      setPhase('success'); draftRef.current = null; setDraft(null); sessionStorage.removeItem('spectre.voice-assistant-session');
      listeningSessionRef.current = false; setVoiceSessionActive(false); window.clearTimeout(voiceTurnTimerRef.current); recognitionRef.current?.abort?.(); recognitionRef.current = null;
      addAssistant(actionDraft.actionType === 'personal_reminder' ? 'Your personal reminder is set.' : `Your email reminder to ${actionDraft.recipientName} is scheduled.`);
      await latestPropsRef.current.onCompleted();
    } catch (err) { activeExecutionIdRef.current = null; if (!openRef.current || cancelledExecutionIdsRef.current.has(actionDraft.draftId)) { cancelledExecutionIdsRef.current.delete(actionDraft.draftId); return; } setError(err.message); setPhase('error'); addAssistant(`I couldn’t create the reminder: ${err.message}`); }
  }
  function confirmDraft() { if (draft) void execute(draft); }
  function cancelDraft() { interrupt(); draftRef.current = null; setDraft(null); setManual(false); setError(''); setPhase('waiting'); sessionStorage.removeItem('spectre.voice-assistant-session'); addAssistant('Okay, I cancelled this reminder draft. Nothing was created.'); }
  function saveManual(event) {
    event.preventDefault(); const data = new FormData(event.currentTarget); const next = { draftId: draft?.draftId || crypto.randomUUID(), actionType: manualType, title: String(data.get('title') || '').trim(), message: String(data.get('message') || '').trim(), recipientName: String(data.get('recipientName') || '').trim(), recipientEmail: String(data.get('recipientEmail') || '').trim(), scheduledDate: String(data.get('scheduledDate') || ''), scheduledTime: String(data.get('scheduledTime') || ''), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    if (next.actionType === 'personal_reminder') next.title ||= next.message;
    if (next.actionType === 'schedule_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.recipientEmail)) { setError('Enter a valid recipient email address.'); return; }
    if (!next.title && next.actionType === 'personal_reminder' || !next.message && next.actionType === 'schedule_email' || !next.scheduledDate || !next.scheduledTime || next.actionType === 'schedule_email' && !next.recipientName) { setError('Complete the required reminder details first.'); return; }
    if (new Date(`${next.scheduledDate}T${next.scheduledTime}`).getTime() <= Date.now()) { setError('Choose a future date and time.'); return; }
    draftRef.current = next; setDraft(next); setManual(false); setError(''); setPhase('waiting');
    const summary = next.actionType === 'schedule_email' ? `I’ll email ${next.recipientName} at ${next.recipientEmail} on ${next.scheduledDate} at ${next.scheduledTime}: “${next.message}”. Please confirm to schedule it.` : `I’ll remind you on ${next.scheduledDate} at ${next.scheduledTime} to ${next.title}. Please confirm to create it.`;
    addAssistant(summary);
  }
  if (!open) return null;
  const ready = Boolean(draft && draft.scheduledDate && draft.scheduledTime && (draft.actionType === 'schedule_email' ? draft.recipientName && draft.recipientEmail && draft.message : draft.title || draft.message));
  return <Modal className="assistant-modal" title="Spectre Assistant" onClose={onClose}><div className="assistant-panel">
    <div className="assistant-state" role="status"><span className={`assistant-state-dot ${phase}`} />{({ idle: 'Ready when you are', listening: 'Listening… say more anytime', processing: voiceSessionActive ? 'Understanding… I’ll keep listening' : 'Understanding your request…', speaking: 'Speaking…', waiting: voiceSessionActive ? 'Conversation open — say more anytime' : 'Waiting for your response', executing: 'Creating reminder…', success: 'Reminder created', error: 'Needs attention' })[phase]}</div>
    <div className="assistant-conversation" aria-live="polite">{messages.slice(-12).map((message, index) => <div className={`assistant-message ${message.role}`} key={`${index}-${message.content}`}><strong>{message.role === 'assistant' ? 'Spectre' : 'You'}</strong><p>{message.content}</p></div>)}</div>
    {draft && (manual || phase !== 'success') && <><div className="assistant-draft"><strong>{draft.actionType === 'schedule_email' ? 'Email reminder draft' : 'Personal reminder draft'}</strong><span>{draft.title || draft.message || 'Add reminder details'}</span><small>{draft.scheduledDate || 'Date needed'} {draft.scheduledTime || 'Time needed'} · {draft.timezone}</small>{draft.actionType === 'schedule_email' && <small>{draft.recipientName || 'Recipient needed'} · {draft.recipientEmail || 'Email needed'}</small>}</div>{manual && <form className="assistant-edit-form" onSubmit={saveManual}><label className="field">Reminder type<select name="actionType" value={manualType} onChange={(event) => setManualType(event.target.value)}><option value="personal_reminder">Personal reminder</option><option value="schedule_email">Email reminder</option></select></label>{manualType === 'schedule_email' && <><label className="field">Recipient name<TextInput name="recipientName" defaultValue={draft.recipientName || ''} /></label><label className="field">Recipient email<TextInput name="recipientEmail" type="email" defaultValue={draft.recipientEmail || ''} /></label></>}<label className="field">What should the reminder say?<TextInput name={manualType === 'personal_reminder' ? 'title' : 'message'} required defaultValue={manualType === 'personal_reminder' ? draft.title || draft.message || '' : draft.message || draft.title || ''} /></label><label className="field">Date<TextInput name="scheduledDate" type="date" required defaultValue={draft.scheduledDate || ''} /></label><label className="field">Time<TextInput name="scheduledTime" type="time" required defaultValue={draft.scheduledTime || ''} /></label><div className="modal-actions"><AppButton type="button" className="secondary-button" onClick={() => setManual(false)}>Back</AppButton><AppButton className="save-task">Save draft</AppButton></div></form>}</>}
    {error && <p className="assistant-error" role="alert">{error}</p>}
    {phase === 'success' && <div className="assistant-success-actions"><AppButton className="secondary-button" onClick={onShowScheduledActions}>View scheduled actions</AppButton><AppButton className="save-task" onClick={() => { const freshMessages = [{ role: 'assistant', content: 'What would you like to remember next?' }]; messagesRef.current = freshMessages; setMessages(freshMessages); setPhase('waiting'); setError(''); }}>Create another</AppButton></div>}
    {phase !== 'success' && <><form className="assistant-input-row" onSubmit={(event) => { event.preventDefault(); const text = transcript.trim(); if (text) { if (voiceSessionActive) stopListening(); setTranscript(''); void interpret(text); } }}><TextInput aria-label="Type a reminder request" placeholder="Say or type what you need to remember…" value={transcript} onChange={(event) => setTranscript(event.target.value)} /><AppButton className="save-task" loading={phase === 'processing'} disabled={!transcript.trim()}>{phase === 'processing' ? 'Thinking…' : 'Send'}</AppButton></form><div className="assistant-controls">{voiceSessionActive ? <AppButton className="assistant-icon-action iconbtn" aria-label="Stop voice conversation" title="Stop conversation" onClick={stopListening}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg></AppButton> : <AppButton className="assistant-icon-action iconbtn" aria-label="Speak now" title={recognitionAvailable ? 'Speak now' : 'Voice input unavailable'} disabled={!recognitionAvailable || phase === 'processing' || phase === 'executing'} onClick={startListening}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.8"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg></AppButton>}<AppButton className="assistant-icon-action iconbtn" aria-label="Replay last response" title="Replay response" disabled={!messages.some((message) => message.role === 'assistant') || phase === 'listening'} onClick={() => { const last = [...messages].reverse().find((message) => message.role === 'assistant'); if (last) speak(last.content); }}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M4 10v4h4l5 4V6l-5 4H4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M17 9a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg></AppButton><AppButton className="assistant-icon-action iconbtn" aria-label={muted ? 'Enable spoken responses' : 'Mute spoken responses'} title={muted ? 'Unmute voice' : 'Mute voice'} onClick={() => setMuted((value) => { if (!value) { window.speechSynthesis?.cancel(); setPhase('waiting'); } return !value; })}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none">{muted ? <><path d="M4 10v4h4l5 4V6l-5 4H4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="m17 9 4 6m0-6-4 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></> : <><path d="M4 10v4h4l5 4V6l-5 4H4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M17 9a5 5 0 0 1 0 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></>}</svg></AppButton>{phase === 'speaking' && <AppButton className="assistant-icon-action iconbtn" aria-label="Interrupt speech" title="Interrupt" onClick={interrupt}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg></AppButton>}{draft && ready && !manual && <AppButton className="save-task" loading={phase === 'executing'} onClick={confirmDraft}>{phase === 'executing' ? 'Creating…' : 'Confirm reminder'}</AppButton>}{draft && !manual && <AppButton className="secondary-button" onClick={() => { setManualType(draft.actionType); setManual(true); }}>Edit</AppButton>}{draft && <AppButton className="cancel-draft" onClick={cancelDraft}>Cancel</AppButton>}</div></>}
  </div></Modal>;
}

function LoadingSplash() {
  return <main className="splash-screen" role="status" aria-label="Loading Spectre">
    <div className="splash-content"><span className="brand-icon splash-mark">✓</span><strong className="splash-name">Spectre</strong><span className="splash-caption">Getting your workspace ready</span><span className="splash-progress" /></div>
  </main>;
}

function GuestReminderPage({ token }) {
  const [reminder, setReminder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api('/guest/reminders/view', { method: 'POST', body: { token }, referrerPolicy: 'no-referrer' })
      .then((data) => { if (active) setReminder(data); })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);
  async function acknowledge() {
    setBusy(true);
    try {
      const result = await api('/guest/reminders/acknowledge', { method: 'POST', body: { token }, referrerPolicy: 'no-referrer' });
      setReminder((current) => ({ ...current, ...result, acknowledgedAt: result.acknowledgedAt ? Date.parse(result.acknowledgedAt) || Date.now() : Date.now() }));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <main className="guest-reminder-page">
    <div className="guest-reminder-card" aria-live="polite">
      <div className="brand guest-reminder-brand"><span className="brand-icon">✓</span>Spectre</div>
      {loading ? <div className="guest-reminder-state"><span className="button-spinner" />Loading reminder…</div> : error && !reminder ? <><h1>Reminder unavailable</h1><p className="guest-reminder-copy">{error}</p><a className="app-button save-task guest-cta" href="/">Try Our App</a></> : reminder?.acknowledgedAt ? <><p className="guest-reminder-eyebrow">Thanks for letting them know</p><h1>Reminder acknowledged!</h1><p className="guest-reminder-copy">Your acknowledgment has been sent to {reminder.senderName}.</p><a className="app-button save-task guest-cta" href="/">Create Your Own Reminder</a></> : reminder ? <><p className="guest-reminder-eyebrow">A message for you</p><h1>You’ve received a reminder!</h1><div className="guest-reminder-meta"><span><small>From</small><strong>{reminder.senderName}</strong></span><span><small>To</small><strong>{reminder.recipientName}</strong></span></div><div className="guest-reminder-message"><small>Message</small><p>{reminder.message}</p></div>{error && <p className="guest-reminder-error" role="alert">{error}</p>}<AppButton className="save-task guest-cta" loading={busy} onClick={acknowledge}>{busy ? 'Sending acknowledgment…' : 'Got it'}</AppButton><p className="guest-reminder-prompt">Want to create and manage your own reminders?</p><a className="guest-app-link" href="/">Try Our App</a></> : null}
    </div>
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
    <TextInput className="check" type="checkbox" checked={task.status === 'Completed'} disabled={toggling} onClick={(event) => event.stopPropagation()} onChange={handleToggle} aria-label="Mark task complete" aria-busy={toggling} /><div className="task-body"><div className="task-title">{task.title}</div>{task.description && <div className="task-desc">{task.description}</div>}<div className="task-meta"><span className={`pill priority-${(task.priority || 'medium').toLowerCase()}`}>{task.priority}</span>{!['To Do', 'Completed'].includes(task.status) && <span className={`pill status ${task.status === 'Acknowledged' ? 'acknowledged' : ''}`}>{task.status}</span>}{(task.tags || []).slice(0, 2).map((tag) => <span className="pill tag" key={tag}>{tag}</span>)}{task.folder && <span className="pill">▱ {task.folder}</span>}{task.due && <span className={`due ${overdue ? 'overdue' : ''}`}>◷ {fmtDate(task.due)}{task.due.includes('T') ? ` · ${fmtDate(task.due, { hour: 'numeric', minute: '2-digit' })}` : ''}</span>}{task.subtasks?.length > 0 && <span className="subcount">☷ {task.subtasks.filter((item) => item.done).length}/{task.subtasks.length}</span>}{task.attachments?.length > 0 && <span className="subcount">⌁ {task.attachments.length}</span>}{task.recurrence && <span className="subcount">↻ {task.recurrence}</span>}{task.emailReminder && <span className="subcount">✉ Email reminder</span>}</div></div><AppButton className="task-quick" title="Edit task" onClick={(event) => { event.stopPropagation(); onEdit(); }}>···</AppButton>
  </article>;
}

function CalendarView({ tasks, googleEvents = [], month, setMonth, selectedDay, setSelectedDay, onCreate, onOpen, onToggle, onEdit, onDrop }) {
  const year = month.getFullYear(); const monthIndex = month.getMonth();
  const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const days = new Date(year, monthIndex + 1, 0).getDate(); const previous = new Date(year, monthIndex, 0).getDate();
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cells = Array.from({ length: 42 }, (_, index) => { const n = index - offset + 1; const date = new Date(year, monthIndex, n); return { iso: isoDate(date), day: n < 1 ? previous + n : n > days ? n - days : n, inMonth: n > 0 && n <= days }; });
  const dayTasks = tasks.filter((task) => task.due?.slice(0, 10) === selectedDay);
  const dayEvents = googleEvents.filter((event) => event.start?.slice(0, 10) === selectedDay || (event.allDay && selectedDay >= event.start && selectedDay < event.end));
  const changeMonth = (amount) => { const next = new Date(year, monthIndex + amount, 1); setMonth(next); setSelectedDay(isoDate(next)); };
  const eventTime = (event) => event.allDay ? 'All day' : `${fmtDate(event.start, { hour: 'numeric', minute: '2-digit' })} – ${fmtDate(event.end, { hour: 'numeric', minute: '2-digit' })}`;
  return <section className="calendar-view"><div className="calendar-header"><AppButton className="iconbtn" aria-label="Previous month" onClick={() => changeMonth(-1)}>‹</AppButton><strong>{fmtDate(month, { month: 'long', year: 'numeric' })}</strong><AppButton className="iconbtn" aria-label="Next month" onClick={() => changeMonth(1)}>›</AppButton><AppButton className="calendar-today" onClick={() => { const current = new Date(); setMonth(new Date(current.getFullYear(), current.getMonth(), 1)); setSelectedDay(localToday()); }}>Today</AppButton></div>
    {googleEvents.length > 0 && <div className="google-calendar-legend"><span aria-hidden="true" /> Google Calendar events</div>}
    <div className="calendar-grid">{weekdays.map((day) => <div className="cal-weekday" key={day}>{day}</div>)}{cells.map(({ iso, day, inMonth }) => { const rows = tasks.filter((task) => task.due?.slice(0, 10) === iso); const events = googleEvents.filter((event) => event.start?.slice(0, 10) === iso || (event.allDay && iso >= event.start && iso < event.end)); return <div role="button" tabIndex="0" className={`cal-day ${inMonth ? '' : 'outside'} ${iso === selectedDay ? 'selected' : ''} ${iso === localToday() ? 'is-today' : ''}`} key={iso} onClick={() => onCreate(iso)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onCreate(iso); }}><span>{day}</span>{rows.slice(0, 3).map((task) => <AppButton type="button" className="cal-task" key={task.id} title={`${task.title} · ${fmtDate(task.due, { year: 'numeric', month: 'long', day: 'numeric' })}`} onClick={(event) => { event.stopPropagation(); onOpen(task); }}>{task.title}<span className="hover-date">{fmtDate(task.due, { month: 'short', day: 'numeric' })}</span></AppButton>)}{events.slice(0, 2).map((event) => event.htmlLink ? <AppButton type="button" className="cal-google-event" key={event.id} title={`${event.title} · ${eventTime(event)}`} onClick={(click) => { click.stopPropagation(); window.open(event.htmlLink, '_blank', 'noopener,noreferrer'); }}>{event.title}<span className="hover-date">{eventTime(event)}</span></AppButton> : <div className="cal-google-event cal-google-event-static" key={event.id} title={`${event.title} · ${eventTime(event)}`}>{event.title}<span className="hover-date">{eventTime(event)}</span></div>)}{rows.length + events.length > 5 && <span className="cal-more">+{rows.length + events.length - 5} more</span>}</div>; })}</div>
    <div className="day-agenda"><div className="agenda-head"><h2>{fmtDate(`${selectedDay}T12:00:00`, { weekday: 'long', month: 'long', day: 'numeric' })}</h2></div><div className="agenda-list">{dayTasks.map((task) => <TaskCard key={task.id} task={task} onToggle={onToggle} onEdit={() => onEdit(task)} onOpen={() => onOpen(task)} onDrop={onDrop} />)}{dayEvents.map((event) => event.htmlLink ? <a className="google-event-agenda" key={event.id} href={event.htmlLink} target="_blank" rel="noreferrer"><span className="google-event-dot" /><span><strong>{event.title}</strong><small>{eventTime(event)}</small></span><span aria-hidden="true">↗</span></a> : <div className="google-event-agenda google-event-static" key={event.id}><span className="google-event-dot" /><span><strong>{event.title}</strong><small>{eventTime(event)}</small></span></div>)}{!dayTasks.length && !dayEvents.length && <div className="empty"><strong>No tasks or events this day</strong><span>Choose a date to create a task for it.</span></div>}</div></div></section>;
}
function TaskDetail({ task, onClose, onEdit, onToggle, onSubtask, onDelete, deleting = false, toggling = false, savingSubtask = false }) {
  return <div className="detail-page-backdrop" role="presentation"><article className="detail-page"><div className="detail-page-header"><AppButton className="secondary-button" onClick={onClose}>← Back</AppButton><div><AppButton className="secondary-button" loading={toggling} onClick={onToggle}>{toggling ? 'Updating…' : task.status === 'Completed' ? 'Mark incomplete' : 'Mark complete'}</AppButton><AppButton className="secondary-button" onClick={onEdit}>Edit task</AppButton><AppButton className="close" aria-label="Close task details" onClick={onClose}>×</AppButton></div></div><div className="detail-kicker">{task.status} · {task.priority}</div><h1>{task.title}</h1>{task.description && <p className="detail-description">{task.description}</p>}<div className="detail-grid">{task.start && <div><small>Start date</small><strong>{fmtDate(task.start, { year: 'numeric', month: 'long', day: 'numeric' })}</strong></div>}{task.due && <div><small>Due</small><strong>{fmtDate(task.due, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong></div>}{task.folder && <div><small>Folder</small><strong>{task.folder}</strong></div>}{task.recurrence && <div><small>Repeat</small><strong>{task.recurrence}</strong></div>}{task.reminder && <div><small>Reminder</small><strong>{task.reminder === 'at-due' ? 'At due time' : `${task.reminder} minutes before`}</strong></div>}{task.emailReminder && <div><small>Email reminder</small><strong>Sent at due time</strong></div>}</div>{task.tags?.length > 0 && <><h3>Tags</h3><div className="detail-tags">{task.tags.map((tag) => <span className="pill tag" key={tag}>{tag}</span>)}</div></>}{task.subtasks?.length > 0 && <><h3>Checklist</h3><ul className="detail-checklist">{task.subtasks.map((item, index) => <li key={`${item.text}-${index}`}><label><TextInput type="checkbox" checked={item.done} disabled={savingSubtask} onChange={() => onSubtask(index)} />{item.text}</label></li>)}</ul></>}{task.attachments?.length > 0 && <><h3>Attachments</h3><ul>{task.attachments.map((file, index) => <li key={`${file.name}-${index}`}>⌁ {file.name}</li>)}</ul></>}{task.notes && <><h3>Notes</h3><p className="detail-description">{task.notes}</p></>}<AppButton className="delete-task detail-delete" loading={deleting} onClick={onDelete}>{deleting ? 'Deleting…' : 'Delete task'}</AppButton></article></div>;
}

function Modal({ title, children, onClose, className = '' }) {
  useEffect(() => { const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', closeOnEscape); return () => window.removeEventListener('keydown', closeOnEscape); }, [onClose]);
  return <div className={`modal-backdrop ${className ? `${className}-backdrop` : ''}`}><section className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-top"><h2>{title}</h2><AppButton className="close" aria-label="Close" onClick={onClose}>×</AppButton></div>{children}</section></div>;
}

function PasswordField({ label, name, value, onChange, required = false, minLength, autoComplete }) {
  const [visible, setVisible] = useState(false);
  return <label className="field password-field">{label}<span className="password-control"><TextInput name={name} required={required} minLength={minLength} autoComplete={autoComplete} type={visible ? 'text' : 'password'} value={value} onChange={onChange} /><AppButton type="button" className="password-toggle" title={visible ? 'Hide password' : 'Show password'} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible} onClick={() => setVisible((show) => !show)}><EyeIcon visible={visible} /></AppButton></span></label>;
}

function EyeIcon({ visible }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M2.5 12s3.2-6 9.5-6 9.5 6 9.5 6-3.2 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" strokeWidth="1.7"/><circle cx="12" cy="12" r="2.7" stroke="currentColor" strokeWidth="1.7"/>{visible && <path d="m4 4 16 16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>}</svg>;
}

function VoiceTextArea({ value, onChange, format = 'bullets', dictationRef, ...props }) {
  const [listening, setListening] = useState(false); const [interim, setInterim] = useState(''); const [unavailable, setUnavailable] = useState(false); const recognitionRef = useRef(null);
  const listeningRef = useRef(false);
  const stopResolverRef = useRef(null);
  const valueRef = useRef(value); valueRef.current = value;
  useEffect(() => {
    if (dictationRef) dictationRef.current = { stop: () => {
      if (!listeningRef.current) return Promise.resolve(valueRef.current);
      return new Promise((resolve) => { stopResolverRef.current = resolve; listeningRef.current = false; recognitionRef.current?.stop(); setListening(false); });
    } };
    return () => { if (dictationRef) dictationRef.current = null; listeningRef.current = false; recognitionRef.current?.stop(); recognitionRef.current = null; stopResolverRef.current?.(valueRef.current); stopResolverRef.current = null; };
  }, [dictationRef]);
  function toggleVoice() {
    if (listeningRef.current) { listeningRef.current = false; recognitionRef.current?.stop(); recognitionRef.current = null; setListening(false); setInterim(''); return; }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { setUnavailable(true); return; }
    const recognition = new Recognition(); recognitionRef.current = recognition; recognition.continuous = true; recognition.interimResults = true; recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event) => { let finalText = ''; let partial = ''; for (let i = event.resultIndex; i < event.results.length; i += 1) { const spoken = event.results[i][0]?.transcript || ''; if (event.results[i].isFinal) finalText += spoken; else partial += spoken; } if (finalText) { const phrase = finalText.trim(); const formatted = format === 'bullets' ? (phrase.match(/[^.!?\n]+[.!?]?/g) || [phrase]).map((part) => part.trim()).filter(Boolean).map((part) => `• ${part}`).join('\n') : phrase; const separator = valueRef.current ? (format === 'bullets' ? '\n' : /[.!?]\s*$/.test(valueRef.current) ? ' ' : '. ') : ''; const next = `${valueRef.current}${separator}${formatted}`; valueRef.current = next; onChange(next); } setInterim(partial); };
    recognition.onerror = (event) => { if (event.error !== 'no-speech' && event.error !== 'aborted') setUnavailable(true); };
    recognition.onend = () => { if (listeningRef.current) { window.setTimeout(() => { if (!listeningRef.current) return; try { recognition.start(); } catch { setUnavailable(true); listeningRef.current = false; setListening(false); } }, 250); } else { recognitionRef.current = null; setListening(false); setInterim(''); stopResolverRef.current?.(valueRef.current); stopResolverRef.current = null; } };
    try { recognition.start(); listeningRef.current = true; setListening(true); setUnavailable(false); } catch { recognitionRef.current = null; listeningRef.current = false; setUnavailable(true); }
  }
  return <div className="voice-note-field"><textarea {...props} value={value} onChange={(event) => { valueRef.current = event.target.value; onChange(event.target.value); }} /><div className="voice-note-controls"><AppButton type="button" className={`voice-note-button ${listening ? 'listening' : ''}`} aria-label={listening ? 'Stop dictation' : 'Dictate note'} title={listening ? 'Stop dictation' : 'Dictate note'} onClick={toggleVoice}>{listening ? <span aria-hidden="true">■</span> : <svg className="voice-mic-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.8"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>}<span>{listening ? 'Stop dictation' : 'Dictate lecture'}</span></AppButton>{listening && <span className="dictation-live"><i /> Recording — tap Stop when finished</span>}{unavailable && <small>Voice typing is not available in this browser. You can type your note instead.</small>}{interim && <small>Hearing: {interim}</small>}</div></div>;
}

function ProfilePage({ username, authUser, profileDraft, setProfileDraft, onUpdate, onPasswordUpdate, onAvatarChange, busyAction, googleCalendarStatus, onConnectCalendar, onDisconnectCalendar, onSignIn }) {
  const [photoError, setPhotoError] = useState('');
  const avatar = profileDraft.avatarUrl || authUser?.avatarUrl;
  function selectPhoto(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { setPhotoError('Choose an image file.'); return; }
    if (file.size > 12 * 1024 * 1024) { setPhotoError('Choose an image smaller than 12 MB.'); return; }
    const objectUrl = URL.createObjectURL(file); const image = new Image();
    image.onload = () => { const side = Math.min(image.naturalWidth, image.naturalHeight); const sx = (image.naturalWidth - side) / 2; const sy = (image.naturalHeight - side) / 2; const canvas = document.createElement('canvas'); const context = canvas.getContext('2d'); let size = 256; let quality = 0.68; let data = ''; do { canvas.width = size; canvas.height = size; context.drawImage(image, sx, sy, side, side, 0, 0, size, size); data = canvas.toDataURL('image/jpeg', quality); size = Math.floor(size * 0.8); quality = Math.max(0.45, quality - 0.06); } while (data.length > 90_000 && size >= 128); URL.revokeObjectURL(objectUrl); setPhotoError(''); onAvatarChange(data); };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); setPhotoError('This image could not be opened.'); }; image.src = objectUrl;
  }
  return <section className="profile-page" aria-label="Profile settings">
    <div className="profile-card profile-overview"><label className="profile-avatar-edit" title="Change profile image"><input type="file" accept="image/*" onChange={selectPhoto} aria-label="Choose profile image" /><span className="profile-avatar">{avatar ? <img src={avatar} alt={`${username}'s profile`} onError={(event) => { event.currentTarget.hidden = true; }} /> : (username || 'U').slice(0, 1).toUpperCase()}</span><span className="profile-avatar-edit-icon" aria-hidden="true">✎</span></label><div><span className="profile-eyebrow">{authUser ? 'Account profile' : 'Guest profile'}</span><h2>{username}</h2><p>{authUser ? 'Manage your details and account security.' : 'Your tasks stay on this device until you sign in.'}</p>{photoError && <small className="profile-photo-error" role="alert">{photoError}</small>}{busyAction === 'profile-image' && <small>Updating photo…</small>}</div></div>
    <form className="profile-card profile-form" onSubmit={onUpdate}><h2>Personal details</h2><div className="form-grid"><label className="field">Username<TextInput required maxLength="80" value={profileDraft.username} onChange={(event) => setProfileDraft({ ...profileDraft, username: event.target.value })} /></label><label className="field">Phone number<TextInput type="tel" maxLength="40" value={profileDraft.phone} onChange={(event) => setProfileDraft({ ...profileDraft, phone: event.target.value })} placeholder="Add a phone number" /></label><label className="field full">Email<TextInput type="email" value={authUser?.email || 'Guest account — no email'} readOnly /></label></div><div className="modal-actions"><AppButton className="save-task" loading={busyAction === 'profile'}>{busyAction === 'profile' ? 'Updating…' : 'Update'}</AppButton></div></form>
    <section className="profile-card google-calendar-card"><div><h2>Google Calendar</h2><p>View your Google Calendar events in Spectre and check for time conflicts when creating tasks.</p>{googleCalendarStatus?.connected && <small>Connected{googleCalendarStatus.email ? ` to ${googleCalendarStatus.email}` : ''}.</small>}</div>{authUser ? googleCalendarStatus?.connected ? <AppButton className="secondary-button" loading={busyAction === 'google-calendar-disconnect'} onClick={onDisconnectCalendar}>Disconnect</AppButton> : <AppButton className="save-task" loading={busyAction === 'google-calendar'} onClick={onConnectCalendar}><GoogleMark />{busyAction === 'google-calendar' ? 'Connecting…' : 'Connect Google Calendar'}</AppButton> : <AppButton className="secondary-button" onClick={onSignIn}>Sign in to connect</AppButton>}</section>{authUser ? <details className="profile-card password-collapse"><summary><h2>Change password</h2><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></summary><form className="profile-form" onSubmit={onPasswordUpdate}><p className="auth-copy">Confirm your current password before choosing a new one.</p><div className="form-grid"><PasswordField name="currentPassword" label="Current password" required autoComplete="current-password" /><PasswordField name="newPassword" label="New password" required minLength="8" autoComplete="new-password" /><PasswordField name="confirmPassword" label="Confirm new password" required minLength="8" autoComplete="new-password" /></div><div className="modal-actions"><AppButton className="save-task" loading={busyAction === 'profile-password'}>{busyAction === 'profile-password' ? 'Updating…' : 'Update password'}</AppButton></div></form></details> : <div className="profile-card profile-signin"><h2>Want to access scheduled actions?</h2><p>Create an account or sign in to use reminders and sync your profile.</p><AppButton className="save-task" onClick={onSignIn}>Sign in or create account</AppButton></div>}
  </section>;
}

const guestReminderToken = getGuestReminderToken();
createRoot(document.getElementById('root')).render(<React.StrictMode>{guestReminderToken ? <GuestReminderPage token={guestReminderToken} /> : <App />}</React.StrictMode>);
