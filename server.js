// ============================================================
// INNER CHAMPION ACADEMY — BACKEND v2
// Student portal + Admin dashboard + password reset + email
//
// Drop-in replacement for the original backend: implements the
// exact API the student portal already calls, plus /api/admin/*.
//
// ENV VARS (set in Railway → service → Variables):
//   JWT_SECRET       required — any long random string
//   ADMIN_EMAIL      required — your admin login email
//   ADMIN_PASSWORD   required — your admin login password
//   DATA_DIR         optional — default ./data (attach a Railway
//                    Volume mounted at /data and set DATA_DIR=/data
//                    so accounts survive redeploys!)
//   RESEND_API_KEY   optional — enables real emails via resend.com
//   FROM_EMAIL       optional — e.g. "ICA <coach@yourdomain.com>"
//   REPLY_TO         optional — where parent replies land (default: kolina@...)
//   PORTAL_URL       optional — used in reset-password emails
// ============================================================

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'ica-data.json');
const PORTAL_URL = process.env.PORTAL_URL || '';

// ─── STORAGE (single JSON file; attach a Railway volume for persistence) ──
let db = { users: {}, resets: {}, notifications: [] };
function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('DB load failed:', e.message); }
  db.users = db.users || {}; db.resets = db.resets || {}; db.notifications = db.notifications || [];
}
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(db));
    } catch (e) { console.error('DB save failed:', e.message); }
  }, 250);
}
loadDB();

// ─── EMAIL (Resend; silently no-ops when key absent) ──────────────────────
let lastEmail = { at: null, to: null, ok: null, error: null };
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    lastEmail = { at: new Date().toISOString(), to, ok: false, error: 'RESEND_API_KEY is not set in Railway Variables — no email was attempted.' };
    console.error('EMAIL SKIPPED: no RESEND_API_KEY');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'ICA <onboarding@resend.dev>',
        reply_to: process.env.REPLY_TO || 'kolina@heartofourfuturefoundation.com',
        to, subject, html })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || ('Resend returned ' + res.status);
      lastEmail = { at: new Date().toISOString(), to, ok: false, error: msg };
      console.error('EMAIL FAILED to', to, '::', msg);
      return false;
    }
    lastEmail = { at: new Date().toISOString(), to, ok: true, error: null };
    return true;
  } catch (e) {
    lastEmail = { at: new Date().toISOString(), to, ok: false, error: e.message };
    console.error('email failed:', e.message);
    return false;
  }
}
// Admin-editable templates: db.portalConfig.emails = { key: {subject, body} }
function tpl(key, fallbackSubject, fallbackBody, vars) {
  const t = ((db.portalConfig || {}).emails || {})[key] || {};
  let subject = t.subject || fallbackSubject;
  let body = t.body || fallbackBody;
  for (const k of Object.keys(vars || {})) {
    const re = new RegExp('{{\\s*' + k + '\\s*}}', 'g');
    subject = subject.replace(re, vars[k]);
    body = body.replace(re, vars[k]);
  }
  // plain line breaks from the editor become paragraphs
  if (!/<[a-z]/i.test(body)) body = body.split(/\n{2,}/).map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
  return { subject, body };
}

function brandEmail(title, bodyHtml) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
    <div style="letter-spacing:.25em;font-size:11px;color:#6B6780;text-transform:uppercase;">Inner Champion Academy</div>
    <h1 style="color:#3A2E7C;font-size:22px;margin:10px 0 16px;">${title}</h1>
    <div style="font-size:15px;line-height:1.6;color:#151320;">${bodyHtml}</div>
    <p style="margin-top:28px;font-size:12px;color:#6B6780;">Heart of Our Future Foundation · Las Vegas, NV<br>"I can and I will, each and every day. Namaste"</p>
  </div>`;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────
function publicUser(u) { const { passwordHash, ...rest } = u; return rest; }
function sign(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '90d' }); }
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try { req.auth = jwt.verify(token, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'Session expired — please log in again' }); }
}
function studentAuth(req, res, next) {
  auth(req, res, () => {
    const u = db.users[req.auth.email];
    if (!u) return res.status(401).json({ error: 'Account not found' });
    req.user = u; next();
  });
}
function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    next();
  });
}
// Only these fields can be written by the student/parent client:
const PROGRESS_FIELDS = ['codeAccepted','notifyEmail','currentDay','completedDays','streak','dayActivities','rewardPicks','dailyDashboard','chatThread','startDate','timezone'];

// ─── STUDENT / PARENT ENDPOINTS (match the portal exactly) ────────────────
// Public self-signup is OFF by default: only accounts the admin creates can log in.
// To allow open registration, set Railway variable OPEN_REGISTRATION=true
app.post('/api/register', async (req, res) => {
  if (String(process.env.OPEN_REGISTRATION || '').toLowerCase() !== 'true') {
    return res.status(403).json({ error: "Accounts are created by Coach after enrollment. Email kolina@heartofourfuturefoundation.com to join the Academy!" });
  }
  const { playerName, email, password, timezone } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!playerName || !em || !password) return res.status(400).json({ error: 'Missing name, email, or password' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.users[em]) return res.status(409).json({ error: 'An account with that email already exists' });
  const u = {
    email: em, playerName, timezone: timezone || 'America/Los_Angeles',
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(), status: 'active',
    currentDay: 1, completedDays: [], streak: 0, dayActivities: [], rewards: [],
    startDate: new Date().toISOString().split('T')[0],
    dailyDashboard: {}, chatThread: [],
    assignedHouseTask: '', parentBulletin: [], ptaLink: db.ptaLink || ''
  };
  db.users[em] = u; saveDB();
  res.json({ token: sign({ email: em }), user: publicUser(u) });
});

app.post('/api/login', async (req, res) => {
  const em = ((req.body || {}).email || '').trim().toLowerCase();
  const u = db.users[em];
  if (!u || !(await bcrypt.compare((req.body || {}).password || '', u.passwordHash)))
    return res.status(401).json({ error: 'Email or password is incorrect' });
  if (u.status === 'previous')
    return res.status(403).json({ error: "This account is no longer active. Email kolina@heartofourfuturefoundation.com to rejoin the Academy!" });
  u.lastLogin = new Date().toISOString(); saveDB();
  res.json({ token: sign({ email: em }), user: withGlobals(u) });
});

function withGlobals(u) {
  const pu = publicUser(u);
  pu.ptaLink = db.ptaLink || u.ptaLink || '';
  pu.portalConfig = db.portalConfig || {};
  pu.parentBulletin = [...(db.globalBulletin || []), ...(u.parentBulletin || [])]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return pu;
}

app.get('/api/me', studentAuth, (req, res) => {
  if (req.user.status === 'previous') return res.status(403).json({ error: 'This account is no longer active.' });
  req.user.lastSeen = new Date().toISOString(); saveDB();
  res.json({ user: withGlobals(req.user) });
});

app.put('/api/progress', studentAuth, (req, res) => {
  for (const k of PROGRESS_FIELDS) if (k in (req.body || {})) req.user[k] = req.body[k];
  req.user.lastSeen = new Date().toISOString();
  saveDB(); res.json({ ok: true });
});

app.post('/api/reward', studentAuth, (req, res) => {
  req.user.rewards = req.user.rewards || [];
  req.user.rewards.push(req.body || {});
  saveDB(); res.json({ ok: true });
});

app.post('/api/address', studentAuth, (req, res) => {
  req.user.certificateAddress = req.body || {};
  saveDB(); res.json({ ok: true });
});

// Parent/champion pinged a message (thread itself syncs via /api/progress).
app.post('/api/message', studentAuth, (req, res) => {
  db.notifications.push({ type: 'message', email: req.user.email, name: req.user.playerName,
    text: ((req.body || {}).text || '').slice(0, 2000), ts: Date.now() });
  if (db.notifications.length > 500) db.notifications = db.notifications.slice(-500);
  saveDB(); res.json({ ok: true });
});

// ─── PASSWORD RESET ───────────────────────────────────────────────────────
app.post('/api/forgot-password', async (req, res) => {
  const em = ((req.body || {}).email || '').trim().toLowerCase();
  res.json({ ok: true }); // always OK — never reveal whether an account exists
  const u = db.users[em]; if (!u) return;
  const tok = crypto.randomBytes(24).toString('hex');
  db.resets[tok] = { email: em, exp: Date.now() + 1000 * 60 * 60 }; saveDB();
  const link = (PORTAL_URL ? PORTAL_URL : '') + '#reset=' + tok;
  await sendEmail(em, 'Reset your Inner Champion Academy password',
    brandEmail('Reset your password',
      `<p>Hi! A password reset was requested for ${u.playerName}'s account.</p>
       <p>${PORTAL_URL ? `<a href="${link}" style="background:#3A2E7C;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;">Reset password</a>` : `Your reset code is: <b>${tok}</b>`}</p>
       <p>This ${PORTAL_URL ? 'link' : 'code'} expires in 1 hour. If you didn't ask for this, you can ignore this email.</p>`));
});

app.post('/api/reset-password', async (req, res) => {
  const { token: tok, password } = req.body || {};
  const r = db.resets[tok];
  if (!r || r.exp < Date.now()) return res.status(400).json({ error: 'That reset link is invalid or expired' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  db.users[r.email].passwordHash = await bcrypt.hash(password, 10);
  delete db.resets[tok]; saveDB();
  res.json({ ok: true });
  sendEmail(r.email, 'Your Inner Champion Academy password was changed',
    brandEmail('Password changed', '<p>Your portal password was just changed. If this wasn\'t you, reply to this email right away.</p>'));
});

// ─── ADMIN ────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const em = ((req.body || {}).email || '').trim().toLowerCase();
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return res.status(500).json({ error: 'Admin login not configured (set ADMIN_EMAIL and ADMIN_PASSWORD)' });
  if (em !== ADMIN_EMAIL || (req.body || {}).password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Email or password is incorrect' });
  res.json({ token: sign({ email: em, role: 'admin' }) });
});

// Admin creates a champion account directly (share the credentials with the family)
app.post('/api/admin/students', adminAuth, async (req, res) => {
  const { playerName, email, password, timezone } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!playerName || !em || !password) return res.status(400).json({ error: 'Missing name, email, or password' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.users[em]) return res.status(409).json({ error: 'An account with that email already exists' });
  db.users[em] = {
    email: em, playerName, timezone: timezone || 'America/Los_Angeles',
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(), createdByAdmin: true, status: 'active',
    currentDay: 1, completedDays: [], streak: 0, dayActivities: [], rewards: [],
    startDate: new Date().toISOString().split('T')[0],
    dailyDashboard: {}, chatThread: [],
    assignedHouseTask: '', parentBulletin: []
  };
  saveDB();
  res.json({ ok: true, email: em });
  {
    const t = tpl('welcome',
      'Welcome to the Inner Champion Academy Portal!',
      `<p>Your champion's portal account is ready.</p>
       <p><b>Website:</b> {{portal}}<br><b>Email:</b> {{email}}<br><b>Temporary password:</b> {{password}}</p>
       <p>Log in together and set up your first day — daily tasks, journal, class RSVPs, and messages with Coach are all inside.</p>`,
      { name: playerName, email: em, password, portal: PORTAL_URL || 'the ICA portal' });
    sendEmail(em, t.subject, brandEmail('Welcome, ' + playerName + '!', t.body));
  }
});

// Roster with per-student summary
app.get('/api/admin/students', adminAuth, (req, res) => {
  const today = new Date().toLocaleDateString('en-CA');
  const students = Object.values(db.users).map(u => {
    const d = (u.dailyDashboard || {})[today] || {};
    const tasksDone = Object.values(d.tasks || {}).filter(Boolean).length;
    const thread = u.chatThread || [];
    const last = thread[thread.length - 1];
    return {
      email: u.email, playerName: u.playerName, timezone: u.timezone,
      status: u.status || 'active', notes: u.notes || '',
      createdAt: u.createdAt, lastSeen: u.lastSeen || u.lastLogin || u.createdAt,
      currentDay: u.currentDay, streak: u.streak,
      todayColor: d.color || null, todayTasksDone: tasksDone, todayBreath: d.breath || 0,
      todayJournal: !!(d.journal || '').trim(), affirmDone: (d.affirm || 0) >= 3,
      subjects: (u.dailyDashboard && u.dailyDashboard._subjects) || [],
      rsvps: (u.dailyDashboard && u.dailyDashboard._rsvps) || {},
      rewardsCount: (u.rewards || []).length,
      assignedHouseTask: u.assignedHouseTask || '',
      lastMessage: last ? { from: last.from, text: last.text, date: last.date } : null,
      unread: last ? last.from === 'parent' && !u.adminReadTs || (last && last.from === 'parent' && (u.adminReadTs || 0) < (thread.length)) : false,
      threadLen: thread.length
    };
  });
  res.json({ students, notifications: db.notifications.slice(-50).reverse(), attendance: db.attendance || {} });
});

// Full student detail
app.get('/api/admin/students/:email', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  u.adminReadTs = (u.chatThread || []).length; saveDB();
  res.json({ student: publicUser(u) });
});

// Set per-student fields (house task, etc.)
app.put('/api/admin/students/:email', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const allowed = ['assignedHouseTask', 'playerName', 'status', 'notes'];
  const taskChanged = ('assignedHouseTask' in (req.body || {})) && req.body.assignedHouseTask && req.body.assignedHouseTask !== u.assignedHouseTask;
  for (const k of allowed) if (k in (req.body || {})) u[k] = req.body[k];
  saveDB(); res.json({ ok: true });
  if (taskChanged && u.notifyEmail !== false) {
    const t = tpl('houseTask', "Today's house task for {{name}}",
      `<p>Coach posted a house task for {{name}}:</p>
       <p style="background:#F8E8A6;padding:12px 16px;border-radius:8px;"><b>{{task}}</b></p>
       <p>It's waiting in the After School section of My Day.</p>`,
      { name: u.playerName, task: req.body.assignedHouseTask });
    sendEmail(u.email, t.subject, brandEmail("Today's house task", t.body));
  }
});

// Change the email on an account (it is also the login, so the record moves)
app.put('/api/admin/students/:email/email', adminAuth, async (req, res) => {
  const oldEm = (req.params.email || '').toLowerCase();
  const newEm = (((req.body || {}).email) || '').trim().toLowerCase();
  const u = db.users[oldEm];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  if (!newEm || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEm)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (newEm === oldEm) return res.status(400).json({ error: 'That is already the email on file' });
  if (db.users[newEm]) return res.status(409).json({ error: 'Another champion already uses that email' });

  // move the record, keeping every bit of history
  u.email = newEm;
  u.previousEmails = (u.previousEmails || []).concat([{ email: oldEm, changedAt: new Date().toISOString() }]);
  db.users[newEm] = u;
  delete db.users[oldEm];

  // carry attendance marks across
  for (const key of Object.keys(db.attendance || {})) {
    if (db.attendance[key] && db.attendance[key][oldEm]) {
      delete db.attendance[key][oldEm];
      db.attendance[key][newEm] = true;
    }
  }
  saveDB();
  res.json({ ok: true, email: newEm });

  const newPw = (req.body || {}).password;
  const t = tpl('emailChanged', 'Your Inner Champion Academy login email was updated',
    `<p>Hi! The login email for <b>{{name}}</b> was updated by Coach.</p>
     <p><b>Website:</b> {{portal}}<br><b>New login email:</b> {{email}}</p>
     <p>Use this address from now on. Your password has not changed{{pwnote}}.</p>`,
    { name: u.playerName, email: newEm, portal: PORTAL_URL || 'the ICA portal', pwnote: newPw ? ' — unless Coach sent you a new one separately' : '' });
  sendEmail(newEm, t.subject, brandEmail('Your login email was updated', t.body));
});

// Reply into a family's thread
app.post('/api/admin/students/:email/message', adminAuth, async (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const text = ((req.body || {}).text || '').slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  u.chatThread = u.chatThread || [];
  u.chatThread.push({ from: 'admin', text, date: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) });
  u.adminReadTs = u.chatThread.length;
  saveDB();
  if ((req.body || {}).email !== false && u.notifyEmail !== false) {
    const t = tpl('coachMessage', 'New message from Coach — Inner Champion Academy',
      `<p>{{message}}</p><p>Reply any time in the Parents section of the portal.</p>`,
      { name: u.playerName, message: text });
    await sendEmail(u.email, t.subject, brandEmail('New message from Coach', t.body));
  }
  res.json({ ok: true });
});

// Bulletin: post to all families (optionally email it)
app.post('/api/admin/bulletin', adminAuth, async (req, res) => {
  const text = ((req.body || {}).text || '').slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Empty note' });
  const note = { text, date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), ts: Date.now(), emailed: false };
  let sent = 0;
  if ((req.body || {}).email !== false) {
    for (const u of Object.values(db.users)) {
      if (u.notifyEmail === false) continue;
      const t = tpl('bulletin', 'ICA Parent Bulletin — note from Coach', `<p>{{message}}</p>`, { name: u.playerName, message: text });
      if (await sendEmail(u.email, t.subject, brandEmail('Parent Bulletin', t.body))) sent++;
    }
    note.emailed = sent > 0;
  }
  db.globalBulletin = db.globalBulletin || [];
  db.globalBulletin.unshift(note);
  db.globalBulletin = db.globalBulletin.slice(0, 20);
  saveDB();
  res.json({ ok: true, emailed: note.emailed, sent });
});

// Roll call: mark who actually attended a class. key = 'YYYY-MM-DD|slotId'
app.put('/api/admin/attendance', adminAuth, (req, res) => {
  const { key, email, present } = req.body || {};
  if (!key || !email) return res.status(400).json({ error: 'Missing key or email' });
  db.attendance = db.attendance || {};
  db.attendance[key] = db.attendance[key] || {};
  if (present) db.attendance[key][email.toLowerCase()] = true;
  else delete db.attendance[key][email.toLowerCase()];
  saveDB(); res.json({ ok: true });
});

// Email diagnostics for the admin dashboard
app.get('/api/admin/email-status', adminAuth, (req, res) => {
  res.json({
    hasKey: !!process.env.RESEND_API_KEY,
    from: process.env.FROM_EMAIL || 'ICA <onboarding@resend.dev>',
    usingSharedSender: !process.env.FROM_EMAIL,
    replyTo: process.env.REPLY_TO || 'kolina@heartofourfuturefoundation.com',
    portalUrl: PORTAL_URL || null,
    lastEmail
  });
});

app.post('/api/admin/email-test', adminAuth, async (req, res) => {
  const to = ((req.body || {}).to || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter an email address to test' });
  const ok = await sendEmail(to, 'ICA test email',
    brandEmail('Test email', '<p>If you can read this, your Inner Champion Academy emails are working. 🎉</p>'));
  res.json({ ok, lastEmail });
});

// ── JOURNEY REPORT + RESET ────────────────────────────────────────────────
function buildReport(u) {
  const dash = u.dailyDashboard || {};
  const dayKeys = Object.keys(dash).filter(k => /^\d{4}-/.test(k)).sort();
  const journals = [];
  let taskTicks = 0, colorDays = 0, affirmDays = 0, breathMins = 0, breathDays = 0;
  for (const k of dayKeys) {
    const d = dash[k] || {};
    if (d.breath) { breathMins += d.breath; breathDays++; }
    taskTicks += Object.values(d.tasks || {}).filter(Boolean).length;
    if (d.color) colorDays++;
    if ((d.affirm || 0) >= 3) affirmDays++;
    if ((d.journal || '').trim() || (d.learned || '').trim())
      journals.push({ date: k, journal: (d.journal || '').trim(), learned: (d.learned || '').trim() });
  }
  // class attendance
  let confirmed = 0, attended = 0;
  for (const key of Object.keys(u.dailyDashboard && u.dailyDashboard._rsvps || {})) confirmed++;
  for (const key of Object.keys(db.attendance || {})) if ((db.attendance[key] || {})[u.email]) attended++;
  const rewards = u.rewards || [];
  const esc = t => String(t == null ? '' : t).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

  const html = `
    <p><b>${esc(u.playerName)}</b> — Inner Champion Academy journey report<br>
    <span style="color:#6B6780">Started ${u.startDate || (u.createdAt || '').split('T')[0]} · report generated ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</span></p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px">
      <tr><td style="padding:7px 0;border-bottom:1px solid #EEEBFA">Days completed</td><td align="right" style="padding:7px 0;border-bottom:1px solid #EEEBFA"><b>${(u.completedDays || []).length} of 62</b></td></tr>
      <tr><td style="padding:7px 0;border-bottom:1px solid #EEEBFA">Longest streak</td><td align="right" style="padding:7px 0;border-bottom:1px solid #EEEBFA"><b>${u.streak || 0} days</b></td></tr>
      <tr><td style="padding:7px 0;border-bottom:1px solid #EEEBFA">Daily tasks checked off</td><td align="right" style="padding:7px 0;border-bottom:1px solid #EEEBFA"><b>${taskTicks}</b></td></tr>
      <tr><td style="padding:7px 0;border-bottom:1px solid #EEEBFA">Days affirmation said ×3</td><td align="right" style="padding:7px 0;border-bottom:1px solid #EEEBFA"><b>${affirmDays}</b></td></tr>
      <tr><td style="padding:7px 0;border-bottom:1px solid #EEEBFA">Breathwork / meditation</td><td align="right" style="padding:7px 0;border-bottom:1px solid #EEEBFA"><b>${breathMins} min across ${breathDays} days</b></td></tr>
      <tr><td style="padding:7px 0;border-bottom:1px solid #EEEBFA">School check-ins</td><td align="right" style="padding:7px 0;border-bottom:1px solid #EEEBFA"><b>${colorDays}</b></td></tr>
      <tr><td style="padding:7px 0;border-bottom:1px solid #EEEBFA">Classes attended / confirmed</td><td align="right" style="padding:7px 0;border-bottom:1px solid #EEEBFA"><b>${attended} / ${confirmed}</b></td></tr>
      <tr><td style="padding:7px 0">Rewards earned</td><td align="right" style="padding:7px 0"><b>${rewards.length}</b></td></tr>
    </table>
    <h3 style="color:#3A2E7C;font-size:15px;letter-spacing:.08em;text-transform:uppercase;margin:22px 0 8px">Rewards &amp; reflections</h3>
    ${rewards.length ? rewards.map(r => `<p style="margin:0 0 10px"><b>${esc(r.reward)}</b> <span style="color:#6B6780">· ${esc(r.weekOrPhase)}</span>${r.reflection ? `<br><i>"${esc(r.reflection)}"</i>` : ''}</p>`).join('') : '<p style="color:#6B6780">None recorded.</p>'}
    <h3 style="color:#3A2E7C;font-size:15px;letter-spacing:.08em;text-transform:uppercase;margin:22px 0 8px">Journal &amp; check-ins</h3>
    ${journals.length ? journals.map(j => `<p style="margin:0 0 10px"><b style="color:#6B6780;font-size:12px">${j.date}</b>${j.learned ? `<br>Learned: ${esc(j.learned)}` : ''}${j.journal ? `<br><i>${esc(j.journal)}</i>` : ''}</p>`).join('') : '<p style="color:#6B6780">None recorded.</p>'}
    <p style="margin-top:24px">Every word above was written by ${esc(u.playerName)}. Keep this — it's the record of who they were becoming.</p>`;
  return { html, stats: { breathMins, breathDays, daysCompleted: (u.completedDays || []).length, streak: u.streak || 0, taskTicks, affirmDays, colorDays, attended, confirmed, rewards: rewards.length, journalEntries: journals.length } };
}

app.get('/api/admin/students/:email/report', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const r = buildReport(u);
  res.json({ html: r.html, stats: r.stats, reportSentAt: u.reportSentAt || null });
});

app.post('/api/admin/students/:email/report', adminAuth, async (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const r = buildReport(u);
  const note = ((req.body || {}).note || '').trim();
  const body = (note ? `<p>${note.replace(/\n/g, '<br>')}</p>` : '') + r.html;
  const ok = await sendEmail(u.email, u.playerName + "'s Inner Champion Academy journey report",
    brandEmail(u.playerName + "'s journey", body));
  u.reportSentAt = new Date().toISOString();
  saveDB();
  res.json({ ok: true, emailed: ok, reportSentAt: u.reportSentAt });
});

// Admin-only: archive the finished journey and start a fresh 62 days
app.post('/api/admin/students/:email/reset', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  if (!u.reportSentAt && !(req.body || {}).force)
    return res.status(409).json({ error: 'No journey report has been sent yet. Send the report first, or confirm to reset anyway.' });
  const dash = u.dailyDashboard || {};
  u.archives = u.archives || [];
  u.archives.push({
    endedAt: new Date().toISOString(), startDate: u.startDate,
    completedDays: u.completedDays || [], streak: u.streak || 0,
    rewards: u.rewards || [], dayActivities: u.dayActivities || [],
    dailyDashboard: dash, reportSentAt: u.reportSentAt || null
  });
  if (u.archives.length > 6) u.archives = u.archives.slice(-6);
  // fresh journey; keep the family's classes, RSVP habits and message thread
  u.currentDay = 1; u.completedDays = []; u.streak = 0; u.dayActivities = []; u.rewards = [];
  u.startDate = new Date().toISOString().split('T')[0];
  u.reportSentAt = null;
  u.dailyDashboard = { _subjects: dash._subjects || [], _rsvps: dash._rsvps || {} };
  saveDB();
  res.json({ ok: true, round: u.archives.length + 1 });
});

// Portal content config: task lists, drills, prompts, live-class links (admin-editable)
app.get('/api/admin/config', adminAuth, (req, res) => res.json({ config: db.portalConfig || {} }));
app.put('/api/admin/config', adminAuth, async (req, res) => {
  const prev = db.portalConfig || {};
  const body = req.body || {};
  db.portalConfig = Object.assign({}, prev, body);
  saveDB(); res.json({ ok: true });
  // Tell families when a live class link is newly posted or changed
  const links = [];
  if (body.growingLink && body.growingLink !== prev.growingLink) links.push(['🧠 Growing Our Brain', body.growingLink, 'creative meditation + creative work']);
  if (body.movingLink && body.movingLink !== prev.movingLink) links.push(['🤸 Moving Our Body', body.movingLink, 'live class · Saturdays & Sundays 7:00 AM PST']);
  if (!links.length) return;
  const html = links.map(l => `<p><b>${l[0]}</b><br><span style="color:#6B6780">${l[2]}</span><br><a href="${l[1]}">${l[1]}</a></p>`).join('');
  for (const u of Object.values(db.users)) {
    if (u.notifyEmail === false) continue;
    await sendEmail(u.email, 'Live class link posted — Inner Champion Academy',
      brandEmail('Join us live', html + '<p>The buttons are also at the top of My Day in the portal.</p>'));
  }
});

// PTA link for everyone
app.put('/api/admin/pta', adminAuth, async (req, res) => {
  const link = ((req.body || {}).link || '').trim();
  const changed = link && link !== db.ptaLink;
  db.ptaLink = link;
  saveDB(); res.json({ ok: true });
  if (!changed) return;
  for (const u of Object.values(db.users)) {
    if (u.notifyEmail === false) continue;
    await sendEmail(u.email, 'PTA meeting link — Inner Champion Academy',
      brandEmail('Friday PTA meeting',
        `<p>Here's the link for our next PTA meeting (every other Friday, 9:00 AM PST):</p>
         <p><a href="${link}">${link}</a></p>
         <p>It's also in the Parents section of the portal.</p>`));
  }
});

// Admin resets a family's password directly
app.post('/api/admin/students/:email/reset-password', adminAuth, async (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const pw = (req.body || {}).password;
  if (!pw || pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  u.passwordHash = await bcrypt.hash(pw, 10); saveDB();
  res.json({ ok: true });
  const t = tpl('passwordChanged', 'Your Inner Champion Academy login was updated',
    `<p>Hi! The portal password for <b>{{name}}</b> was just updated by Coach.</p>
     <p><b>Website:</b> {{portal}}<br><b>Email:</b> {{email}}<br><b>New password:</b> {{password}}</p>
     <p>Log in any time to pick up where your champion left off.</p>`,
    { name: u.playerName, email: u.email, password: pw, portal: PORTAL_URL || 'the ICA portal' });
  sendEmail(u.email, t.subject, brandEmail('Your login was updated', t.body));
});

app.get('/', (req, res) => res.json({ ok: true, service: 'ICA backend v2' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ICA backend v2 listening on ' + PORT));
