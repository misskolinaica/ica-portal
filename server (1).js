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
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.FROM_EMAIL || 'ICA <onboarding@resend.dev>', to, subject, html })
    });
    return res.ok;
  } catch (e) { console.error('email failed:', e.message); return false; }
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
const PROGRESS_FIELDS = ['currentDay','completedDays','streak','dayActivities','rewardPicks','dailyDashboard','chatThread','startDate','timezone'];

// ─── STUDENT / PARENT ENDPOINTS (match the portal exactly) ────────────────
app.post('/api/register', async (req, res) => {
  const { playerName, email, password, timezone } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!playerName || !em || !password) return res.status(400).json({ error: 'Missing name, email, or password' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.users[em]) return res.status(409).json({ error: 'An account with that email already exists' });
  const u = {
    email: em, playerName, timezone: timezone || 'America/Los_Angeles',
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(),
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
    createdAt: new Date().toISOString(), createdByAdmin: true,
    currentDay: 1, completedDays: [], streak: 0, dayActivities: [], rewards: [],
    startDate: new Date().toISOString().split('T')[0],
    dailyDashboard: {}, chatThread: [],
    assignedHouseTask: '', parentBulletin: []
  };
  saveDB();
  res.json({ ok: true, email: em });
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
      createdAt: u.createdAt, lastSeen: u.lastSeen || u.lastLogin || u.createdAt,
      currentDay: u.currentDay, streak: u.streak,
      todayColor: d.color || null, todayTasksDone: tasksDone,
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
  const allowed = ['assignedHouseTask', 'playerName'];
  for (const k of allowed) if (k in (req.body || {})) u[k] = req.body[k];
  saveDB(); res.json({ ok: true });
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
  if ((req.body || {}).email) await sendEmail(u.email, 'New message from Coach — Inner Champion Academy',
    brandEmail('New message from Coach', `<p>${text}</p><p>Reply any time in the Parents section of the portal.</p>`));
  res.json({ ok: true });
});

// Bulletin: post to all families (optionally email it)
app.post('/api/admin/bulletin', adminAuth, async (req, res) => {
  const text = ((req.body || {}).text || '').slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Empty note' });
  const note = { text, date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), ts: Date.now(), emailed: false };
  let sent = 0;
  if ((req.body || {}).email) {
    for (const u of Object.values(db.users)) {
      if (await sendEmail(u.email, 'ICA Parent Bulletin — note from Coach', brandEmail('Parent Bulletin', `<p>${text}</p>`))) sent++;
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

// Portal content config: task lists, drills, prompts, live-class links (admin-editable)
app.get('/api/admin/config', adminAuth, (req, res) => res.json({ config: db.portalConfig || {} }));
app.put('/api/admin/config', adminAuth, (req, res) => {
  db.portalConfig = Object.assign({}, db.portalConfig || {}, req.body || {});
  saveDB(); res.json({ ok: true });
});

// PTA link for everyone
app.put('/api/admin/pta', adminAuth, (req, res) => {
  db.ptaLink = ((req.body || {}).link || '').trim();
  saveDB(); res.json({ ok: true });
});

// Admin resets a family's password directly
app.post('/api/admin/students/:email/reset-password', adminAuth, async (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const pw = (req.body || {}).password;
  if (!pw || pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  u.passwordHash = await bcrypt.hash(pw, 10); saveDB();
  res.json({ ok: true });
});

app.get('/', (req, res) => res.json({ ok: true, service: 'ICA backend v2' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ICA backend v2 listening on ' + PORT));
