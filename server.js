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
//   ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET
//                    optional, NOT YET WIRED — see "ZOOM" section below.
//                    Until a real Zoom Server-to-Server app is connected,
//                    Coach pastes Zoom links by hand on each calendar event.
//
// v3 (CRM update): calendar events, RSVP confirm/decline, bulletin read
// receipts + delete, message edit/delete/archive, conversation folders.
// Same single-file JSON storage — redeploy this file to Railway.
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
let db = { users: {}, resets: {}, notifications: [], orgs: {} };
function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('DB load failed:', e.message); }
  db.users = db.users || {}; db.resets = db.resets || {}; db.notifications = db.notifications || [];
  // CRM additions (v3) — every older data file upgrades in place, nothing is lost.
  //   db.calendarEvents  — null until Coach creates/imports the first event (the portal
  //                        keeps using the old weekly schedule until then)
  //   db.globalBulletin  — each note gains an id + readBy {email: ts} for read receipts
  //   db.msgMeta         — admin-only thread organisation: archived threads + folders
  if (!('calendarEvents' in db)) db.calendarEvents = null;
  db.globalBulletin = (db.globalBulletin || []).map(n => Object.assign({ id: newId('b'), readBy: {} }, n, { readBy: n.readBy || {} }));
  db.msgMeta = db.msgMeta || {};
  db.msgMeta.archived = db.msgMeta.archived || {};
  db.msgMeta.folders = db.msgMeta.folders || [];
  // ─── ONE SHARED SEASON DAY (v4) ───────────────────────────────────────
  // The whole Academy moves together: every champion is on the same day
  // number, counted from this single date. Coach can change it from the
  // admin dashboard (PUT /api/admin/config). Each student's own
  // `user.startDate` is left untouched — it stays in the data as history.
  db.portalConfig = db.portalConfig || {};
  if (!isSeasonDate(db.portalConfig.seasonStart)) db.portalConfig.seasonStart = DEFAULT_SEASON_START;
  // ─── ORGANIZATIONS (v5) ───────────────────────────────────────────────
  // Each athlete belongs to exactly one organization, and EACH ORGANIZATION
  // runs its own 62-day season from its own start date. One school can start
  // in September and another in October — nobody is dragged onto someone
  // else's clock any more. db.portalConfig.seasonStart stays in the payload
  // for older portals, but the per-org date is what actually counts.
  db.orgs = (db.orgs && typeof db.orgs === 'object') ? db.orgs : {};
  // Upgrading an existing data file: every seeded org inherits the season
  // start that was already live, so no champion's day number moves today.
  const inherited = isSeasonDate(db.portalConfig.seasonStart) ? db.portalConfig.seasonStart : DEFAULT_SEASON_START;
  for (const s of SEED_ORGS) {
    if (!db.orgs[s.id]) db.orgs[s.id] = { id: s.id, name: s.name, seasonStart: inherited, seasonDays: SEASON_DAYS, active: true, createdAt: new Date().toISOString() };
  }
  for (const id of Object.keys(db.orgs)) {
    const o = db.orgs[id] || {};
    db.orgs[id] = {
      id,
      name: String(o.name || id).slice(0, 80),
      seasonStart: isSeasonDate(o.seasonStart) ? o.seasonStart : '',
      seasonDays: Number(o.seasonDays) > 0 ? Number(o.seasonDays) : SEASON_DAYS,
      active: o.active !== false,
      createdAt: o.createdAt || new Date().toISOString()
    };
  }
  if (typeof db.defaultOrgId !== 'string' || !db.orgs[db.defaultOrgId]) db.defaultOrgId = DEFAULT_ORG_ID;
  // Squarespace → org routing, and the replay guard for order ids
  db.signupOrgMap = (db.signupOrgMap && typeof db.signupOrgMap === 'object') ? db.signupOrgMap : {};
  db.seenOrders = Array.isArray(db.seenOrders) ? db.seenOrders : [];
}

// ─── SEASON DAY HELPERS ───────────────────────────────────────────────────
// 2026-09-04 + 39 days = 2026-10-13, which is Day 40. (Day 1 is the start date
// itself, so day = daysElapsed + 1, clamped to 1..62.)
const SEASON_DAYS = 62;
const DEFAULT_SEASON_START = '2026-09-04';
const DEFAULT_TZ = 'America/Los_Angeles';
const DEFAULT_ORG_ID = 'community';
// Seeded on first boot. These four ids and names are a shared contract with
// the admin dashboard — do not rename them.
const SEED_ORGS = [
  { id: 'juventus',  name: 'Juventus' },
  { id: 'tpd',       name: 'TPD' },
  { id: 'community', name: 'COMMUNITY - ALL CLASSES' },
  { id: 'garside',   name: 'Garside Junior High School' }
];
function isSeasonDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t);
}
function seasonStartStr() {
  const s = (db.portalConfig || {}).seasonStart;
  return isSeasonDate(s) ? s : DEFAULT_SEASON_START;
}
// day number for a 'YYYY-MM-DD' calendar date, clamped into the season
function seasonDayForDate(dateStr, start) {
  const ss = isSeasonDate(start) ? start : seasonStartStr();
  if (!isSeasonDate(dateStr)) return 1;
  const elapsed = Math.round((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(ss + 'T00:00:00Z')) / 86400000);
  return Math.max(1, Math.min(elapsed + 1, SEASON_DAYS));
}
function seasonDayNow() { return seasonDayForDate(laToday()); }

// ─── ORGANIZATION HELPERS ─────────────────────────────────────────────────
function slugOrgId(s) {
  return String(s == null ? '' : s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function defaultOrgId() { return db.orgs[db.defaultOrgId] ? db.defaultOrgId : DEFAULT_ORG_ID; }
// Any athlete with no org, or an org that no longer exists, belongs to the
// default org. We heal the record the moment we read it, so an athlete can
// never be orphaned by a renamed or deleted organization.
function orgIdFor(u) {
  const id = (u && typeof u.org === 'string') ? u.org : '';
  if (id && db.orgs[id]) return id;
  const def = defaultOrgId();
  if (u && u.org !== def) u.org = def;
  return def;
}
function orgFor(u) { return db.orgs[orgIdFor(u)] || null; }
function orgHasStart(o) { return !!(o && isSeasonDate(o.seasonStart)); }
function tzDateKey(d, tz) {
  try { return d.toLocaleDateString('en-CA', { timeZone: tz }); } catch (e) { return d.toLocaleDateString('en-CA'); }
}
function tzHourOf(d, tz) {
  try {
    const h = d.toLocaleString('en-US', { timeZone: tz, hour12: false, hour: '2-digit' });
    return (Number(String(h).trim()) || 0) % 24;
  } catch (e) { return d.getHours(); }
}
// seasonDayFor(user) — THE day number for this athlete: counted from their own
// organization's seasonStart, in their own timezone, keeping the 3AM rule (a
// champion still up at 1AM is finishing the day they were working on).
// Returns null when the organization has NOT STARTED — either no start date is
// set yet, or the date Coach set is still in the future. That is PRE-SEASON:
// not day zero, not a missed day, nothing closed.
function seasonDayFor(u) {
  const o = orgFor(u);
  if (!orgHasStart(o)) return null;
  const tz = (u && u.timezone) || DEFAULT_TZ;
  const now = new Date();
  let elapsed = Math.round((Date.parse(tzDateKey(now, tz) + 'T00:00:00Z') - Date.parse(o.seasonStart + 'T00:00:00Z')) / 86400000);
  if (tzHourOf(now, tz) < 3 && elapsed > 0) elapsed -= 1;
  if (elapsed < 0) return null;                       // the season has not begun yet
  const days = o.seasonDays || SEASON_DAYS;
  return Math.max(1, Math.min(elapsed + 1, days));
}
// The same number for an organization as a whole, on Coach's Pacific clock.
function seasonDayOfOrg(o) {
  if (!orgHasStart(o)) return null;
  return seasonDayFor({ org: o.id, timezone: DEFAULT_TZ });
}
// Has this organization's season actually begun? (A date set for next month is
// still "not started".) Per-athlete, because it turns over in their timezone.
function orgStarted(o, u) {
  if (!orgHasStart(o)) return false;
  return seasonDayFor(u || { org: o.id, timezone: DEFAULT_TZ }) !== null;
}
// The shape the portal and the dashboard both read off the user object.
function orgPublic(o, u) {
  if (!o) return null;
  return { id: o.id, name: o.name, seasonStart: o.seasonStart || '', seasonDays: o.seasonDays || SEASON_DAYS, started: orgStarted(o, u) };
}
function orgAthleteCount(id) {
  let n = 0;
  for (const u of Object.values(db.users)) if (orgIdFor(u) === id) n++;
  return n;
}
function orgSummary(o) {
  return Object.assign({}, o, { athleteCount: orgAthleteCount(o.id), seasonDay: seasonDayOfOrg(o), started: orgStarted(o) });
}
function orgsSummary() {
  return Object.values(db.orgs).map(orgSummary)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
}
function pushNotification(n) {
  db.notifications.push(n);
  if (db.notifications.length > 500) db.notifications = db.notifications.slice(-500);
}
function newId(prefix) { return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'); }
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
// NEVER let a student-facing response carry the coach's weekly readiness
// evaluation. publicUser() is the only door to /api/me, /api/login and
// /api/progress responses, so `evals` is stripped here, once, for all of them.
function publicUser(u) { const { passwordHash, evals, ...rest } = u; return rest; }
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
    org: defaultOrgId(),
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
  delete pu.evals;                 // belt and braces: the evaluation is coach-only
  pu.ptaLink = db.ptaLink || u.ptaLink || '';
  pu.portalConfig = db.portalConfig || {};
  // The athlete's organization and THEIR season day. `seasonDay` is null when
  // their organization has not started yet — the portal shows a calm
  // "your season starts soon" screen and does not open the daily game.
  pu.org = orgPublic(orgFor(u), u);
  pu.seasonDay = seasonDayFor(u);
  // Families see whether THEY have read each note — never who else has.
  pu.parentBulletin = [...(db.globalBulletin || []), ...(u.parentBulletin || [])]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .map(n => { const { readBy, ...rest } = n; return Object.assign(rest, { read: !!(readBy && readBy[u.email]) }); });
  // Calendar: null = coach hasn't switched to the new calendar yet (portal uses the old schedule)
  pu.calendarEvents = Array.isArray(db.calendarEvents) ? eventsForUser(u) : null;
  return pu;
}

// ─── CALENDAR HELPERS ─────────────────────────────────────────────────────
const EVENT_TYPES = ['VEGAS Yoga Class', 'MOVING OUR BODY - ONLINE Yoga Class', 'GROWING OUR BRAIN - art meditations', 'ICA Event', '1:1 LEADER', 'PTA MEETING'];
// Group events with no attendee list are for every active champion; otherwise only listed champions.
function eventIsFor(ev, email) {
  if (!ev) return false;
  if (ev.type === 'PTA MEETING' && !(ev.attendees || []).length) return true;
  if (ev.mode === 'one') return (ev.attendees || [])[0] === email;
  return !(ev.attendees || []).length || ev.attendees.includes(email);
}
function eventsForUser(u) {
  // Families never receive the full attendee list of other people's events.
  return (db.calendarEvents || []).filter(ev => eventIsFor(ev, u.email))
    .map(ev => { const { attendees, ...rest } = ev; return Object.assign(rest, { invitedCount: (attendees || []).length }); });
}
function cleanEvent(body, prev) {
  const b = body || {}, p = prev || {};
  const pick = (k, d) => (k in b ? b[k] : (k in p ? p[k] : d));
  const ev = {
    id: p.id || b.id || newId('ev'),
    type: EVENT_TYPES.includes(pick('type')) ? pick('type') : EVENT_TYPES[0],
    title: String(pick('title', '') || '').slice(0, 140),
    date: String(pick('date', '') || ''),
    start: String(pick('start', '') || ''),
    end: String(pick('end', '') || ''),
    recur: ['none', 'weekly', 'biweekly'].includes(pick('recur')) ? pick('recur') : 'none',
    days: Array.isArray(pick('days')) ? pick('days').map(Number).filter(n => n >= 0 && n <= 6) : [],
    until: String(pick('until', '') || ''),
    skip: Array.isArray(pick('skip')) ? pick('skip').map(String) : [],
    location: String(pick('location', '') || '').slice(0, 200),
    zoomLink: String(pick('zoomLink', '') || '').slice(0, 500),
    mode: pick('mode') === 'one' ? 'one' : 'group',
    attendees: Array.isArray(pick('attendees')) ? pick('attendees').map(e => String(e).toLowerCase()) : [],
    notes: String(pick('notes', '') || '').slice(0, 2000),
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return { error: 'Pick a date for the event' };
  if (ev.mode === 'one' && ev.attendees.length !== 1) return { error: 'A 1:1 booking needs exactly one champion' };
  if (ev.recur !== 'none' && !ev.days.length) ev.days = [new Date(ev.date + 'T00:00:00').getDay()];
  return { ev };
}

// ─── CHAT EDIT/DELETE SAFETY ──────────────────────────────────────────────
// The portal saves its whole chatThread through /api/progress. If a family's
// screen still holds a message Coach edited or deleted, re-apply Coach's
// change so a stale copy can never bring it back.
function msgSig(m) { return (m.from || '') + '|' + (m.date || '') + '|' + (m.text || ''); }
function applyChatTombstones(u, thread) {
  if (!Array.isArray(thread)) return thread;
  const dead = new Set(u.chatTombstones || []);
  const edits = u.chatEdits || {};
  return thread.filter(m => !(m && m.from === 'admin' && dead.has(msgSig(m)))).map(m => {
    if (!m || m.from !== 'admin') return m;
    let cur = m, hops = 0;
    while (edits[msgSig(cur)] && hops++ < 10) cur = Object.assign({}, cur, { text: edits[msgSig(cur)], edited: true });
    return cur;
  });
}

app.get('/api/me', studentAuth, (req, res) => {
  if (req.user.status === 'previous') return res.status(403).json({ error: 'This account is no longer active.' });
  req.user.lastSeen = new Date().toISOString(); saveDB();
  res.json({ user: withGlobals(req.user) });
});

app.put('/api/progress', studentAuth, (req, res) => {
  for (const k of PROGRESS_FIELDS) if (k in (req.body || {})) req.user[k] = req.body[k];
  if ('chatThread' in (req.body || {})) req.user.chatThread = applyChatTombstones(req.user, req.user.chatThread);
  req.user.lastSeen = new Date().toISOString();
  saveDB(); res.json({ ok: true });
});

// RSVP: champion/parent answers one event occurrence. key = 'YYYY-MM-DD|eventId'
// answer = 'yes' | 'no' | null (clear). Stored in the same dailyDashboard._rsvps
// (yes only — what roll call reads) + _rsvpAnswered (yes/no) the portal already uses.
app.post('/api/rsvp', studentAuth, (req, res) => {
  const { key, answer } = req.body || {};
  if (!key || !/^\d{4}-\d{2}-\d{2}\|/.test(key)) return res.status(400).json({ error: 'Missing event key' });
  const dash = req.user.dailyDashboard = req.user.dailyDashboard || {};
  dash._rsvps = dash._rsvps || {}; dash._rsvpAnswered = dash._rsvpAnswered || {};
  if (answer === 'yes') { dash._rsvps[key] = true; dash._rsvpAnswered[key] = 'yes'; }
  else if (answer === 'no') { delete dash._rsvps[key]; dash._rsvpAnswered[key] = 'no'; }
  else { delete dash._rsvps[key]; delete dash._rsvpAnswered[key]; }
  saveDB(); res.json({ ok: true });
});

// Bulletin read receipt from the Parents screen
app.post('/api/bulletin/:id/read', studentAuth, (req, res) => {
  const n = (db.globalBulletin || []).find(x => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Note not found' });
  n.readBy = n.readBy || {};
  n.readBy[req.user.email] = Date.now();
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
  // `from` says who in the family wrote it ('parent' | 'child'); older portals omit it.
  const who = ((req.body || {}).from === 'child') ? 'child' : 'parent';
  db.notifications.push({ type: 'message', email: req.user.email, name: req.user.playerName,
    from: who,
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
  // Which organization this athlete joins (their season clock comes from it)
  const wantOrg = String((req.body || {}).org || '').trim();
  if (wantOrg && !db.orgs[wantOrg]) return res.status(400).json({ error: 'That organization does not exist' });
  db.users[em] = {
    email: em, playerName, timezone: timezone || 'America/Los_Angeles',
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(), createdByAdmin: true, status: 'active',
    org: wantOrg || defaultOrgId(),
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
    const org = orgFor(u);
    return {
      email: u.email, playerName: u.playerName, timezone: u.timezone,
      org: orgIdFor(u), orgName: (org && org.name) || '', seasonDay: seasonDayFor(u),
      status: u.status || 'active', notes: u.notes || '', birthYear: u.birthYear || null,
      createdAt: u.createdAt, lastSeen: u.lastSeen || u.lastLogin || u.createdAt,
      currentDay: u.currentDay, streak: u.streak,
      todayColor: d.color || null, todayWin: String(d.win || '').trim() || null,
      todayScreen: d.screen || null, todayTasksDone: tasksDone, todayBreath: d.breath || 0,
      todayJournal: !!(d.journal || '').trim(), affirmDone: (d.affirm || 0) >= 3,
      subjects: (u.dailyDashboard && u.dailyDashboard._subjects) || [],
      rsvps: (u.dailyDashboard && u.dailyDashboard._rsvps) || {},
      rsvpAnswered: (u.dailyDashboard && u.dailyDashboard._rsvpAnswered) || {},
      archived: !!db.msgMeta.archived[u.email],
      rewardsCount: (u.rewards || []).length,
      assignedHouseTask: u.assignedHouseTask || '',
      lastMessage: last ? { from: last.from, text: last.text, date: last.date } : null,
      unread: last ? last.from === 'parent' && !u.adminReadTs || (last && last.from === 'parent' && (u.adminReadTs || 0) < (thread.length)) : false,
      threadLen: thread.length
    };
  });
  // Each organization keeps its own season day; the orgs summary rides along so
  // the dashboard can render its filters without a second call. seasonStart /
  // seasonDay stay here for older dashboards.
  saveDB();   // reading the roster heals any athlete whose org went missing
  res.json({ students, notifications: db.notifications.slice(-50).reverse(), attendance: db.attendance || {},
    orgs: orgsSummary(), defaultOrgId: defaultOrgId(),
    seasonStart: seasonStartStr(), seasonDay: seasonDayNow(), seasonDays: SEASON_DAYS });
});

// Full student detail
app.get('/api/admin/students/:email', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  u.adminReadTs = (u.chatThread || []).length; saveDB();
  res.json({ student: Object.assign(publicUser(u), { org: orgIdFor(u), orgName: (orgFor(u) || {}).name || '', seasonDay: seasonDayFor(u) }),
    orgs: orgsSummary(), defaultOrgId: defaultOrgId() });
});

// Set per-student fields (house task, etc.)
app.put('/api/admin/students/:email', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const allowed = ['assignedHouseTask', 'playerName', 'status', 'notes', 'birthYear'];
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
  // ...and calendar invites, bulletin read receipts, archive flag + folders
  for (const ev of (db.calendarEvents || [])) ev.attendees = (ev.attendees || []).map(e => e === oldEm ? newEm : e);
  for (const n of (db.globalBulletin || [])) if (n.readBy && n.readBy[oldEm]) { n.readBy[newEm] = n.readBy[oldEm]; delete n.readBy[oldEm]; }
  if (db.msgMeta.archived[oldEm]) { db.msgMeta.archived[newEm] = true; delete db.msgMeta.archived[oldEm]; }
  for (const f of db.msgMeta.folders) f.members = (f.members || []).map(e => e === oldEm ? newEm : e);
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
  u.chatThread.push({ from: 'admin', to: ((req.body || {}).to === 'child' ? 'child' : 'parent'), text, date: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) });
  u.adminReadTs = u.chatThread.length;
  saveDB();
  if ((req.body || {}).email !== false && u.notifyEmail !== false && (req.body || {}).to !== 'child') {
    const t = tpl('coachMessage', 'New message from Coach — Inner Champion Academy',
      `<p>{{message}}</p><p>Reply any time in the Parents section of the portal.</p>`,
      { name: u.playerName, message: text });
    await sendEmail(u.email, t.subject, brandEmail('New message from Coach', t.body));
  }
  res.json({ ok: true });
});

// Send one message into several family threads at once (parents only)
app.post('/api/admin/message-group', adminAuth, async (req, res) => {
  const emails = ((req.body || {}).emails || []).map(e => String(e).toLowerCase());
  const text = (((req.body || {}).text) || '').slice(0, 2000);
  const alsoEmail = (req.body || {}).email !== false;
  if (!emails.length) return res.status(400).json({ error: 'Pick at least one family' });
  if (!text) return res.status(400).json({ error: 'Write a message first' });
  const stamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let delivered = 0, mailed = 0;
  for (const em of emails) {
    const u = db.users[em];
    if (!u) continue;
    u.chatThread = u.chatThread || [];
    u.chatThread.push({ from: 'admin', to: ((req.body || {}).to === 'child' ? 'child' : 'parent'), text, date: stamp, group: true });
    u.adminReadTs = u.chatThread.length;
    delivered++;
    if (alsoEmail && u.notifyEmail !== false && ((req.body||{}).to !== 'child')) {
      const t = tpl('coachMessage', 'New message from Coach — Inner Champion Academy',
        `<p>{{message}}</p><p>Reply any time in the Parents section of the portal.</p>`,
        { name: u.playerName, message: text });
      if (await sendEmail(u.email, t.subject, brandEmail('New message from Coach', t.body))) mailed++;
    }
  }
  saveDB();
  res.json({ ok: true, delivered, mailed });
});

// Bulletin: post to all families (optionally email it)
app.post('/api/admin/bulletin', adminAuth, async (req, res) => {
  const text = ((req.body || {}).text || '').slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Empty note' });
  const note = { id: newId('b'), text, date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), ts: Date.now(), emailed: false, readBy: {} };
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
  // Keep up to 100 notes. Notes are only removed by Coach (after every parent has read them).
  db.globalBulletin = db.globalBulletin.slice(0, 100);
  saveDB();
  res.json({ ok: true, emailed: note.emailed, sent, id: note.id });
});

// Bulletin list with read receipts. "Active parents" = one per active champion account.
function activeEmails() { return Object.values(db.users).filter(u => (u.status || 'active') === 'active').map(u => u.email); }
function bulletinSummary(n) {
  const active = activeEmails();
  const readBy = n.readBy || {};
  const read = active.filter(e => readBy[e]);
  return { id: n.id, text: n.text, date: n.date, ts: n.ts, emailed: n.emailed,
    readCount: read.length, activeCount: active.length, readBy: read,
    pending: active.filter(e => !readBy[e]), canDelete: read.length >= active.length };
}
app.get('/api/admin/bulletin', adminAuth, (req, res) => {
  res.json({ bulletins: (db.globalBulletin || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(bulletinSummary) });
});
// Deleting is only allowed once 100% of active parents confirmed they read it.
app.delete('/api/admin/bulletin/:id', adminAuth, (req, res) => {
  const i = (db.globalBulletin || []).findIndex(x => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Note not found' });
  const sum = bulletinSummary(db.globalBulletin[i]);
  if (!sum.canDelete) return res.status(409).json({ error: 'Waiting on ' + sum.pending.length + ' of ' + sum.activeCount + ' parents to confirm they have read this note.' });
  db.globalBulletin.splice(i, 1);
  saveDB(); res.json({ ok: true });
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

// Season prep reminder (shown in the dashboard, emailable to the coach)
app.get('/api/admin/season-reminder', adminAuth, (req, res) => {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = last - now.getDate();
  res.json({
    daysLeftInMonth: daysLeft,
    due: daysLeft <= 7,
    dismissedFor: db.seasonReminderDismissed || null,
    monthKey: now.getFullYear() + '-' + (now.getMonth() + 1)
  });
});
app.post('/api/admin/season-reminder', adminAuth, async (req, res) => {
  const body = req.body || {};
  if (body.dismiss) { db.seasonReminderDismissed = body.monthKey || null; saveDB(); return res.json({ ok: true, dismissed: true }); }
  const to = ADMIN_EMAIL;
  const ok = await sendEmail(to, 'Time to prep the next ICA season',
    brandEmail('Next season prep',
      `<p>The month is nearly over — time to plan the next 8–16 weeks of Inner Champion Academy classes.</p>
       <ul>
         <li>Choose the next 8-week mobility topic</li>
         <li>Refresh the 3 yoga drills for the month</li>
         <li>Update journal prompts for the new curriculum</li>
         <li>Confirm class times and post the live class links</li>
         <li>Open registration and message current families</li>
       </ul>`));
  res.json({ ok: true, emailed: ok, to });
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
function buildReport(u, includeDates) {
  const filterSet = Array.isArray(includeDates) && includeDates.length ? new Set(includeDates) : null;
  const dash = u.dailyDashboard || {};
  const dayKeys = Object.keys(dash).filter(k => /^\d{4}-/.test(k)).sort();
  const journals = [];
  let taskTicks = 0, colorDays = 0, affirmDays = 0, breathMins = 0, breathDays = 0;
  for (const k of dayKeys) {
    const d = dash[k] || {};
    if (d.breath) { breathMins += d.breath; breathDays++; }
    taskTicks += Object.values(d.tasks || {}).filter(Boolean).length;
    if (d.color || String(d.win || '').trim()) colorDays++;   // `win` replaced `color`; count either
    if ((d.affirm || 0) >= 3) affirmDays++;
    if (((d.journal || '').trim() || (d.learned || '').trim() || String(d.win || '').trim()) && (!filterSet || filterSet.has(k)))
      journals.push({ date: k, journal: (d.journal || '').trim(), learned: (d.learned || '').trim(), color: d.color || null, win: String(d.win || '').trim() });
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
    ${journals.length ? journals.map(j => `<p style="margin:0 0 10px"><b style="color:#6B6780;font-size:12px">${j.date}</b>${j.win ? `<br>Win of the day: ${esc(j.win)}` : ''}${j.learned ? `<br>Learned: ${esc(j.learned)}` : ''}${j.journal ? `<br><i>${esc(j.journal)}</i>` : ''}</p>`).join('') : '<p style="color:#6B6780">None recorded.</p>'}
    <p style="margin-top:24px">Every word above was written by ${esc(u.playerName)}. Keep this — it's the record of who they were becoming.</p>`;
  return { html, stats: { breathMins, breathDays, daysCompleted: (u.completedDays || []).length, streak: u.streak || 0, taskTicks, affirmDays, colorDays, attended, confirmed, rewards: rewards.length, journalEntries: journals.length } };
}

app.get('/api/admin/students/:email/entries', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const dash = u.dailyDashboard || {};
  const entries = Object.keys(dash).filter(k => /^\d{4}-/.test(k)).sort().reverse().map(k => {
    const d = dash[k] || {};
    return {
      date: k,
      journal: (d.journal || '').trim(),
      learned: (d.learned || '').trim(),
      win: String(d.win || '').trim(),
      screen: d.screen || null,
      subjLearned: d.subjLearned || {},
      color: d.color || null,
      breath: d.breath || 0,
      tasksDone: Object.values(d.tasks || {}).filter(Boolean).length,
      affirm: (d.affirm || 0) >= 3
    };
  }).filter(e => e.journal || e.learned || e.win || e.color || e.breath || e.tasksDone || e.screen);
  const messages = (u.chatThread || []).filter(m => m.from === 'parent');
  const reflections = (u.rewards || []).filter(r => (r.reflection || '').trim())
    .map(r => ({ reward: r.reward, weekOrPhase: r.weekOrPhase, reflection: r.reflection, date: r.date }));
  res.json({ entries, messages, reflections });
});

app.get('/api/admin/students/:email/report', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const r = buildReport(u);
  res.json({ html: r.html, stats: r.stats, reportSentAt: u.reportSentAt || null });
});

app.post('/api/admin/students/:email/report', adminAuth, async (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const r = buildReport(u, (req.body || {}).include);
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

// Nudge families to confirm their class attendance in the portal
app.post('/api/admin/rsvp-reminder', adminAuth, async (req, res) => {
  const only = (req.body || {}).email ? [(req.body.email || '').toLowerCase()] : null;
  let sent = 0, skipped = 0;
  for (const u of Object.values(db.users)) {
    if (only && !only.includes(u.email)) continue;
    if ((u.status || 'active') !== 'active' || u.notifyEmail === false) { skipped++; continue; }
    const t = tpl('rsvpReminder', 'Please confirm this week\'s classes — Inner Champion Academy',
      `<p>Hi! A quick reminder to open the portal with {{name}} and tap <b>"I'll be there"</b> on the classes they plan to attend this week.</p>
       <p>Confirming their own classes is part of the practice — it teaches responsibility and it helps Coach plan each session.</p>
       <p><b>Portal:</b> {{portal}} → tap <b>📅 Schedule</b></p>`,
      { name: u.playerName, portal: PORTAL_URL || 'the ICA portal' });
    if (await sendEmail(u.email, t.subject, brandEmail('Confirm your classes', t.body))) sent++;
  }
  res.json({ ok: true, sent, skipped });
});

// Portal content config: task lists, drills, prompts, live-class links (admin-editable)
app.get('/api/admin/config', adminAuth, (req, res) => res.json({
  config: Object.assign({}, db.portalConfig || {}, { seasonStart: seasonStartStr() }),
  seasonDay: seasonDayNow(), seasonDays: SEASON_DAYS }));
app.put('/api/admin/config', adminAuth, async (req, res) => {
  const prev = db.portalConfig || {};
  const body = Object.assign({}, req.body || {});
  // The shared season start drives EVERY champion's day number, so a bad
  // value is rejected rather than quietly moving the whole Academy.
  if ('seasonStart' in body) {
    if (!isSeasonDate(body.seasonStart))
      return res.status(400).json({ error: 'seasonStart must be a real date in YYYY-MM-DD form (e.g. 2026-09-04).' });
  }
  db.portalConfig = Object.assign({}, prev, body);
  if (!isSeasonDate(db.portalConfig.seasonStart)) db.portalConfig.seasonStart = DEFAULT_SEASON_START;
  saveDB(); res.json({ ok: true, seasonStart: db.portalConfig.seasonStart, seasonDay: seasonDayNow() });
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

// ══════════════════════════════════════════════════════════════════════════
// ORGANIZATIONS (admin)  —  each one runs its own 62-day season
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/admin/orgs', adminAuth, (req, res) => {
  saveDB();   // reading heals any athlete whose org went missing
  res.json({ orgs: orgsSummary(), defaultOrgId: defaultOrgId(), seasonDays: SEASON_DAYS });
});

app.post('/api/admin/orgs', adminAuth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name the organization' });
  let seasonStart = '';
  if ('seasonStart' in b && b.seasonStart !== '' && b.seasonStart != null) {
    if (!isSeasonDate(b.seasonStart))
      return res.status(400).json({ error: 'seasonStart must be a real date in YYYY-MM-DD form (e.g. 2026-09-04), or empty until you know it.' });
    seasonStart = b.seasonStart;
  }
  const base = slugOrgId(b.id || name);
  if (!base) return res.status(400).json({ error: 'That name has no letters or numbers to make an id from' });
  let id = base, n = 2;
  while (db.orgs[id]) id = (base + '-' + n++).slice(0, 40);
  db.orgs[id] = { id, name, seasonStart, seasonDays: SEASON_DAYS, active: true, createdAt: new Date().toISOString() };
  saveDB();
  res.json({ ok: true, org: orgSummary(db.orgs[id]), defaultOrgId: defaultOrgId() });
});

app.put('/api/admin/orgs/:id', adminAuth, (req, res) => {
  const o = db.orgs[req.params.id];
  if (!o) return res.status(404).json({ error: 'Organization not found' });
  const b = req.body || {};
  // A bad date would move a whole school's day number, so it is rejected
  // outright and NOTHING on the record changes.
  if ('seasonStart' in b) {
    if (b.seasonStart === '' || b.seasonStart === null) { /* clear → pre-season */ }
    else if (!isSeasonDate(b.seasonStart))
      return res.status(400).json({ error: 'seasonStart must be a real date in YYYY-MM-DD form (e.g. 2026-09-04), or empty to clear it.' });
  }
  if ('name' in b) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Name the organization' });
    o.name = name;
  }
  if ('seasonStart' in b) o.seasonStart = isSeasonDate(b.seasonStart) ? b.seasonStart : '';
  if ('active' in b) o.active = !!b.active;
  if ('seasonDays' in b && Number(b.seasonDays) > 0) o.seasonDays = Math.min(366, Math.round(Number(b.seasonDays)));
  saveDB();
  res.json({ ok: true, org: orgSummary(o) });
});

// Deleting an organization never deletes an athlete: everyone in it moves to
// the default org, keeping every day, journal entry and reward they earned.
app.delete('/api/admin/orgs/:id', adminAuth, (req, res) => {
  const id = req.params.id;
  const o = db.orgs[id];
  if (!o) return res.status(404).json({ error: 'Organization not found' });
  if (id === defaultOrgId())
    return res.status(409).json({ error: 'This is the default organization — every athlete without an org lands here, so it cannot be deleted. Make another organization the default first.' });
  const to = defaultOrgId();
  let moved = 0;
  for (const u of Object.values(db.users)) {
    if ((typeof u.org === 'string' ? u.org : '') === id) { u.org = to; moved++; }
  }
  delete db.orgs[id];
  // any product→org routing that pointed here stops pointing at a ghost
  for (const k of Object.keys(db.signupOrgMap || {})) if (db.signupOrgMap[k] === id) delete db.signupOrgMap[k];
  saveDB();
  res.json({ ok: true, moved, movedTo: to, movedToName: (db.orgs[to] || {}).name || to });
});

// Move one athlete between organizations (their season day follows the org)
app.put('/api/admin/students/:email/org', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const id = String((req.body || {}).org || '').trim();
  if (!id || !db.orgs[id]) return res.status(400).json({ error: 'Pick an organization that exists' });
  u.org = id;
  saveDB();
  res.json({ ok: true, email: u.email, org: id, orgName: db.orgs[id].name, seasonDay: seasonDayFor(u) });
});

// ══════════════════════════════════════════════════════════════════════════
// SQUARESPACE / ZAPIER SUBSCRIPTION → ACCOUNT + WELCOME EMAIL
//
// POST /api/signup/subscription          (NOT behind adminAuth)
// Auth: header `x-ica-signup-secret: <SIGNUP_SECRET>` OR `?secret=...`
// (Zapier and Make cannot always set headers). SIGNUP_SECRET lives in Railway
// Variables; with it unset, every call is rejected.
// ══════════════════════════════════════════════════════════════════════════
// Readable temp password: no 0/O/1/l/I, so a parent can retype it off a phone.
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function tempPassword(len) {
  const n = Math.max(12, len || 14);
  const limit = Math.floor(256 / PW_ALPHABET.length) * PW_ALPHABET.length;   // reject bias
  let out = '';
  while (out.length < n) {
    for (const byte of crypto.randomBytes(n * 2)) {
      if (byte >= limit) continue;
      out += PW_ALPHABET[byte % PW_ALPHABET.length];
      if (out.length >= n) break;
    }
  }
  return out;
}
function signupSecretOk(req) {
  const want = process.env.SIGNUP_SECRET || '';
  if (!want) return false;
  const got = String(req.headers['x-ica-signup-secret'] || (req.query || {}).secret || '');
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}
function firstString(list) {
  for (const v of list) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}
function signupEmail(b) {
  const ba = b.billingAddress || b.billing_address || {};
  return firstString([b.email, b.customerEmail, b.customer_email, ba.email]).toLowerCase();
}
function signupName(b, em) {
  const ba = b.billingAddress || b.billing_address || {};
  const joined = [ba.firstName || ba.first_name || '', ba.lastName || ba.last_name || ''].join(' ');
  return (firstString([b.name, b.playerName, b.player_name, b.customerName, b.customer_name, joined])
    || String(em).split('@')[0] || 'Champion').slice(0, 80);
}
// An exact org id wins; then productName/sku through the coach-editable map;
// then the default organization. Nobody ever lands nowhere.
function signupOrg(b) {
  const direct = String(b.org || '').trim();
  if (direct && db.orgs[direct]) return direct;
  const map = db.signupOrgMap || {};
  for (const k of ['productName', 'product_name', 'product', 'sku', 'productId', 'product_id']) {
    const v = b[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    const hit = map[v.trim().toLowerCase()];
    if (hit && db.orgs[hit]) return hit;
  }
  return defaultOrgId();
}

app.post('/api/signup/subscription', async (req, res) => {
  if (!signupSecretOk(req)) return res.status(401).json({ error: 'Not authorised' });
  const b = req.body || {};
  const em = signupEmail(b);
  if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'An email address is required' });
  const orderId = (b.orderId == null ? '' : String(b.orderId)).trim().slice(0, 120);
  const name = signupName(b, em);
  const org = signupOrg(b);
  const stamp = typeof b.timestamp === 'string' ? b.timestamp.slice(0, 40) : null;
  try {
    // Replay guard: Squarespace and Zapier both retry, so the same order only
    // ever creates one account.
    db.seenOrders = Array.isArray(db.seenOrders) ? db.seenOrders : [];
    if (orderId && db.seenOrders.indexOf(orderId) !== -1) return res.json({ ok: true, created: false, duplicate: true });
    if (orderId) {
      db.seenOrders.push(orderId);
      if (db.seenOrders.length > 2000) db.seenOrders = db.seenOrders.slice(-2000);
    }
    // Already a family here: no duplicate account, and NEVER a fresh set of
    // credentials by email — that would hand anyone who knows the address a
    // working login. Coach sees it in the signups list instead.
    if (db.users[em]) {
      pushNotification({ type: 'signup-existing', email: em, name, org, orderId: orderId || null, timestamp: stamp, ts: Date.now() });
      saveDB();
      return res.json({ ok: true, created: false });
    }
    const pw = tempPassword(14);
    db.users[em] = {
      email: em, playerName: name, timezone: DEFAULT_TZ,
      passwordHash: await bcrypt.hash(pw, 10),
      createdAt: new Date().toISOString(), createdBySignup: true, status: 'active',
      org,
      signup: { orderId: orderId || null, timestamp: stamp, productName: firstString([b.productName, b.product_name, b.product, b.sku]) || null },
      currentDay: 1, completedDays: [], streak: 0, dayActivities: [], rewards: [],
      startDate: new Date().toISOString().split('T')[0],
      dailyDashboard: {}, chatThread: [],
      assignedHouseTask: '', parentBulletin: []
    };
    pushNotification({ type: 'signup', email: em, name, org, orderId: orderId || null, timestamp: stamp, ts: Date.now() });
    saveDB();

    // An email that will not send must never fail the webhook — Squarespace
    // would retry forever and the account already exists.
    let emailed = false, why = null;
    try {
      const t = tpl('welcome',
        'Welcome to the Inner Champion Academy Portal!',
        `<p>Your champion's portal account is ready.</p>
         <p><b>Website:</b> {{portal}}<br><b>Email:</b> {{email}}<br><b>Temporary password:</b> {{password}}</p>
         <p>Log in together and set up your first day — daily tasks, journal, class RSVPs, and messages with Coach are all inside.</p>`,
        { name, email: em, password: pw, portal: PORTAL_URL || 'the ICA portal' });
      emailed = await sendEmail(em, t.subject, brandEmail('Welcome, ' + name + '!', t.body));
      if (!emailed) why = (lastEmail && lastEmail.error) || 'the email was not accepted';
    } catch (e) { why = e.message; }
    if (!emailed) console.error('SIGNUP: account created for', em, 'but the welcome email did not send ::', why);
    res.json({ ok: true, created: true, emailed, org });
  } catch (e) {
    console.error('signup webhook failed:', e.message);
    res.status(500).json({ error: 'Signup could not be processed' });
  }
});

// Recent Squarespace signups + the product→org routing map
app.get('/api/admin/signups', adminAuth, (req, res) => {
  const signups = (db.notifications || [])
    .filter(n => n && (n.type === 'signup' || n.type === 'signup-existing'))
    .slice(-100).reverse()
    .map(n => Object.assign({}, n, { orgName: (db.orgs[n.org] || {}).name || n.org || '' }));
  res.json({ signups, map: db.signupOrgMap || {},
    endpoint: '/api/signup/subscription',
    secretConfigured: !!process.env.SIGNUP_SECRET,   // the secret itself is never sent
    orgs: orgsSummary(), defaultOrgId: defaultOrgId() });
});

app.put('/api/admin/signup-map', adminAuth, (req, res) => {
  const map = (req.body || {}).map;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return res.status(400).json({ error: 'Send { map: { "product name": "orgId" } }' });
  const next = {};
  for (const k of Object.keys(map)) {
    const key = String(k || '').trim().toLowerCase().slice(0, 120);
    const val = String(map[k] || '').trim();
    if (!key) continue;
    if (!db.orgs[val]) return res.status(400).json({ error: '"' + key + '" points at an organization that does not exist: ' + val });
    next[key] = val;
  }
  db.signupOrgMap = next;
  saveDB();
  res.json({ ok: true, map: db.signupOrgMap });
});

// ─── CALENDAR EVENTS (admin CRUD) ─────────────────────────────────────────
// null until the first event is saved; the dashboard offers to import the old
// weekly rhythm (keeping the old slot ids so existing RSVPs + roll call carry over).
app.get('/api/admin/events', adminAuth, (req, res) => res.json({ events: db.calendarEvents, types: EVENT_TYPES }));
app.post('/api/admin/events', adminAuth, (req, res) => {
  const list = Array.isArray((req.body || {}).events) ? req.body.events : [req.body || {}];   // bulk import or single
  const made = [];
  for (const b of list) {
    const r = cleanEvent(b);
    if (r.error) return res.status(400).json({ error: r.error });
    if ((db.calendarEvents || []).some(e => e.id === r.ev.id)) r.ev.id = newId('ev');
    made.push(r.ev);
  }
  db.calendarEvents = (db.calendarEvents || []).concat(made);
  saveDB(); res.json({ ok: true, events: made });
});
app.put('/api/admin/events/:id', adminAuth, (req, res) => {
  const i = (db.calendarEvents || []).findIndex(e => e.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Event not found' });
  const r = cleanEvent(req.body, db.calendarEvents[i]);
  if (r.error) return res.status(400).json({ error: r.error });
  db.calendarEvents[i] = r.ev;
  saveDB(); res.json({ ok: true, event: r.ev });
});
// ?date=YYYY-MM-DD removes a single occurrence of a recurring event; otherwise the whole event.
app.delete('/api/admin/events/:id', adminAuth, (req, res) => {
  const i = (db.calendarEvents || []).findIndex(e => e.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Event not found' });
  const one = String(req.query.date || '');
  if (one) { const ev = db.calendarEvents[i]; ev.skip = Array.from(new Set((ev.skip || []).concat([one]))); }
  else db.calendarEvents.splice(i, 1);
  saveDB(); res.json({ ok: true });
});

// ─── ZOOM (stub — no Zoom API connected yet) ──────────────────────────────
// To go live: create a Zoom "Server-to-Server OAuth" app, add ZOOM_ACCOUNT_ID,
// ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in Railway Variables, then replace the body of
// createZoomMeeting() with: get a token from https://zoom.us/oauth/token
// (grant_type=account_credentials) and POST https://api.zoom.us/v2/users/me/meetings.
// Return { join_url }. The dashboard already calls this endpoint and fills the link in.
async function createZoomMeeting(/* { topic, date, start, end } */) {
  return null;   // ← the one line to swap: return the real meeting object here
}
app.post('/api/admin/zoom/meeting', adminAuth, async (req, res) => {
  const configured = !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
  const m = configured ? await createZoomMeeting(req.body || {}) : null;
  if (m && m.join_url) return res.json({ ok: true, configured: true, joinUrl: m.join_url });
  res.status(501).json({ ok: false, configured,
    error: configured ? 'Zoom keys are set but createZoomMeeting() is still the stub — finish it in server.js.'
                      : 'Zoom is not connected. Paste the meeting link from Zoom by hand, or add ZOOM_* keys in Railway.' });
});

// ─── MESSAGE EDIT / DELETE (Coach's own messages only) ────────────────────
function adminMsgAt(req, res) {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) { res.status(404).json({ error: 'Student not found' }); return null; }
  const i = Number(req.params.idx), m = (u.chatThread || [])[i];
  if (!m) { res.status(404).json({ error: 'Message not found' }); return null; }
  if (m.from !== 'admin') { res.status(403).json({ error: "Only Coach's own messages can be edited or deleted" }); return null; }
  // Optional guard against editing the wrong bubble if the thread moved underneath us
  const expect = (req.body && req.body.expectText) || req.query.expectText;
  if (expect && expect !== m.text) { res.status(409).json({ error: 'This thread changed — refresh and try again' }); return null; }
  return { u, i, m };
}
app.put('/api/admin/students/:email/message/:idx', adminAuth, (req, res) => {
  const r = adminMsgAt(req, res); if (!r) return;
  const text = (((req.body || {}).text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Empty message' });
  r.u.chatEdits = r.u.chatEdits || {};
  r.u.chatEdits[msgSig(r.m)] = text;
  r.m.text = text; r.m.edited = true; r.m.editedAt = new Date().toISOString();
  saveDB(); res.json({ ok: true });
});
app.delete('/api/admin/students/:email/message/:idx', adminAuth, (req, res) => {
  const r = adminMsgAt(req, res); if (!r) return;
  r.u.chatTombstones = (r.u.chatTombstones || []).concat([msgSig(r.m)]).slice(-500);
  r.u.chatThread.splice(r.i, 1);
  r.u.adminReadTs = r.u.chatThread.length;
  saveDB(); res.json({ ok: true });
});

// ─── THREAD ARCHIVE + FOLDERS (admin-only organisation) ───────────────────
app.get('/api/admin/msg-meta', adminAuth, (req, res) => res.json({ archived: db.msgMeta.archived, folders: db.msgMeta.folders }));
app.put('/api/admin/threads/:email/archive', adminAuth, (req, res) => {
  const em = (req.params.email || '').toLowerCase();
  if (!db.users[em]) return res.status(404).json({ error: 'Student not found' });
  if ((req.body || {}).archived === false) delete db.msgMeta.archived[em]; else db.msgMeta.archived[em] = true;
  saveDB(); res.json({ ok: true });
});
app.post('/api/admin/folders', adminAuth, (req, res) => {
  const name = (((req.body || {}).name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name the folder' });
  const f = { id: newId('f'), name, pinned: !!(req.body || {}).pinned, members: [], createdAt: new Date().toISOString() };
  db.msgMeta.folders.push(f);
  saveDB(); res.json({ ok: true, folder: f });
});
app.put('/api/admin/folders/:id', adminAuth, (req, res) => {
  const f = db.msgMeta.folders.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Folder not found' });
  const b = req.body || {};
  if ('name' in b && String(b.name).trim()) f.name = String(b.name).trim().slice(0, 60);
  if ('pinned' in b) f.pinned = !!b.pinned;
  if (Array.isArray(b.members)) f.members = Array.from(new Set(b.members.map(e => String(e).toLowerCase())));
  if (b.email) {   // toggle one conversation in/out
    const em = String(b.email).toLowerCase();
    f.members = (f.members || []).filter(e => e !== em);
    if (b.member !== false) f.members.push(em);
  }
  saveDB(); res.json({ ok: true, folder: f });
});
app.delete('/api/admin/folders/:id', adminAuth, (req, res) => {
  const before = db.msgMeta.folders.length;
  db.msgMeta.folders = db.msgMeta.folders.filter(x => x.id !== req.params.id);
  if (db.msgMeta.folders.length === before) return res.status(404).json({ error: 'Folder not found' });
  saveDB(); res.json({ ok: true });   // conversations themselves are untouched
});

// ══════════════════════════════════════════════════════════════════════════
// WEEKLY READINESS EVALUATION (LEVEL I) + FRIDAY PROGRESS EMAIL  (v4)
//
// Six categories, each scored 5 / 3 / 1:
//   Attendance & Punctuality  AUTO  (class confirmations + roll call)
//   Effort & Engagement       COACH
//   Emotional Regulation      COACH
//   Coachability              COACH
//   Habit Accountability      AUTO  (daily submissions in the game)
//   Peer Respect              COACH
// Stored on the user as user.evals['YYYY-Www'] — NEVER sent to a student.
// ══════════════════════════════════════════════════════════════════════════

// ─── WEEK IDS (weeks start SUNDAY, in America/Los_Angeles) ────────────────
const LA_TZ = 'America/Los_Angeles';
function dayNum(key) { const p = String(key).split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000; }
function keyOfDayNum(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function dowOfKey(key) { return new Date(String(key) + 'T00:00:00Z').getUTCDay(); }   // 0 = Sunday
function addDaysKey(key, n) { return keyOfDayNum(dayNum(key) + n); }
// "today" and the clock, as Coach's own wall time in Las Vegas / Pacific
function laNow(when) {
  const base = when || new Date();
  const key = base.toLocaleDateString('en-CA', { timeZone: LA_TZ });
  const hm = base.toLocaleString('en-US', { timeZone: LA_TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  const t = hm.trim().split(':').map(Number);
  return { key, dow: dowOfKey(key), hour: (t[0] || 0) % 24, minute: t[1] || 0 };
}
function laToday() { return laNow().key; }
function weekStartKey(key) { return addDaysKey(key, -dowOfKey(key)); }                 // the Sunday
function firstSundayOf(year) { const j = year + '-01-01'; return addDaysKey(j, (7 - dowOfKey(j)) % 7); }
// weekId(date) = YYYY + '-W' + 2-digit week number, week starting Sunday
function weekIdFromKey(key) {
  const ws = weekStartKey(key);
  const year = Number(ws.slice(0, 4));
  const w = 1 + Math.round((dayNum(ws) - dayNum(firstSundayOf(year))) / 7);
  return year + '-W' + (w < 10 ? '0' : '') + w;
}
function weekId(date) { return weekIdFromKey(date instanceof Date ? laNow(date).key : (date || laToday())); }
function weekStartFromId(id) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(String(id || ''));
  if (!m) return null;
  const w = Number(m[2]);
  if (w < 1 || w > 53) return null;
  return addDaysKey(firstSundayOf(Number(m[1])), (w - 1) * 7);
}
function currentWeekId() { return weekIdFromKey(laToday()); }
function weekDateKeys(ws) { const out = []; for (let i = 0; i < 7; i++) out.push(addDaysKey(ws, i)); return out; }
function prettyDate(key) {
  return new Date(key + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}
function weekLabel(ws) { return prettyDate(ws) + ' – ' + prettyDate(addDaysKey(ws, 6)); }

// ─── AUTO SCORING ─────────────────────────────────────────────────────────
// Same recurrence maths the dashboard calendar uses, so "expected classes"
// means exactly what Coach sees on the calendar.
function eventOccursOn(ev, key) {
  if (!ev || !ev.date || key < ev.date) return false;
  if (ev.until && key > ev.until) return false;
  if ((ev.skip || []).indexOf(key) !== -1) return false;
  if (!ev.recur || ev.recur === 'none') return key === ev.date;
  const startDow = dowOfKey(ev.date);
  const days = (ev.days && ev.days.length) ? ev.days : [startDow];
  if (days.indexOf(dowOfKey(key)) === -1) return false;
  if (ev.recur === 'biweekly') {
    const weeks = Math.floor((dayNum(key) - (dayNum(ev.date) - startDow)) / 7);
    if (weeks % 2 !== 0) return false;
  }
  return true;
}
// How many ticks make a day's task list "done"? Whatever Coach published.
function requiredTaskCount() {
  const cfg = db.portalConfig || {};
  const n = ['tasksMorn', 'tasksAfter', 'tasksEven'].reduce((s, k) => s + ((cfg[k] || []).length || 0), 0);
  return n > 0 ? n : 6;    // no config saved yet → the spec's fallback
}
// Class occurrences that belonged to THIS champion in the week (PTA is a
// parents' meeting, so it never counts against a child's attendance).
// Only classes that have ALREADY occurred count — a Friday-evening class can
// never be an "absence" in the Friday-morning report.
function occurrencesForUserInWeek(u, ws) {
  const out = [];
  if (!Array.isArray(db.calendarEvents)) return out;
  const today = laToday();
  for (const date of weekDateKeys(ws)) {
    if (date > today) continue;
    for (const ev of db.calendarEvents) {
      if (!ev || ev.type === 'PTA MEETING') continue;
      if (!eventIsFor(ev, u.email)) continue;
      if (!eventOccursOn(ev, date)) continue;
      out.push({ key: date + '|' + ev.id, date, ev });
    }
  }
  return out.sort((a, b) => (a.date + (a.ev.start || '')).localeCompare(b.date + (b.ev.start || '')));
}
function dayIsComplete(d, need) {
  const ticks = Object.values((d || {}).tasks || {}).filter(Boolean).length;
  return !!String((d || {}).win || '').trim() && !!((d || {}).screen && d.screen.locked === true) && ticks >= need;
}
// scoreWeek(user, weekStart) — the two AUTO categories, plus the raw counts
// so the dashboard can show Coach why the score came out that way.
function scoreWeek(u, ws) {
  const dash = u.dailyDashboard || {};
  const rsvps = dash._rsvps || {};
  const occ = occurrencesForUserInWeek(u, ws);
  const expected = occ.length;
  let attended = 0, confirmed = 0;
  const classes = occ.map(o => {
    const was = !!((db.attendance || {})[o.key] || {})[u.email];
    const conf = rsvps[o.key] === true;
    if (was) attended++;
    if (conf) confirmed++;
    return { key: o.key, date: o.date, title: o.ev.title || o.ev.type, start: o.ev.start || '', attended: was, confirmed: conf };
  });
  const missed = Math.max(0, expected - attended);
  let attendance = 5, attendanceNote = null;
  if (expected === 0) { attendance = 5; attendanceNote = 'no classes scheduled'; }
  else if (missed === 0 && confirmed >= expected) attendance = 5;          // perfect + confirmed in advance
  else if (missed >= 2) attendance = 1;                                     // frequent absences
  else attendance = 3;                                                      // one absence, or came without confirming

  const need = requiredTaskCount();
  let completeDays = 0, submittedDays = 0, taskTicks = 0, screenMins = 0, journalDays = 0;
  for (const date of weekDateKeys(ws)) {
    const d = dash[date] || {};
    const ticks = Object.values(d.tasks || {}).filter(Boolean).length;
    taskTicks += ticks;
    if ((d.screen || {}).mins) screenMins += Number(d.screen.mins) || 0;
    if (String(d.journal || '').trim()) journalDays++;
    if (String(d.win || '').trim() || ticks || (d.screen && d.screen.locked)) submittedDays++;
    if (dayIsComplete(d, need)) completeDays++;
  }
  const habit = completeDays >= 5 ? 5 : (completeDays >= 2 ? 3 : 1);
  return { attendance, habit, attendanceNote, expected, attended, confirmed, missed,
    classes, completeDays, submittedDays, taskTicks, screenMins, journalDays, taskTarget: need };
}

const COACH_FIELDS = ['effort', 'emotional', 'coachability', 'peer'];
function blankEval() { return { effort: null, emotional: null, coachability: null, peer: null, coachNote: '', scoredAt: null }; }
// Only the coach-entered fields come out of storage — the AUTO scores are
// always recomputed live, so a frozen send-time copy can never shadow them.
function evalFor(u, week) {
  const stored = ((u.evals || {})[week]) || {};
  const ev = blankEval();
  for (const f of COACH_FIELDS) ev[f] = [1, 3, 5].includes(stored[f]) ? stored[f] : null;
  ev.coachNote = String(stored.coachNote || '');
  ev.scoredAt = stored.scoredAt || null;
  return ev;
}
function evalTotal(ev, auto) {
  let total = (auto ? (auto.attendance || 0) + (auto.habit || 0) : 0);
  let scored = auto ? 2 : 0;
  for (const f of COACH_FIELDS) if (ev[f]) { total += ev[f]; scored++; }
  return { total, scoredCategories: scored, maxTotal: 30 };
}
function evalRow(u, week, ws) {
  const ev = evalFor(u, week);
  const auto = scoreWeek(u, ws);
  const t = evalTotal(ev, auto);
  return Object.assign({
    email: u.email, playerName: u.playerName || u.email, status: u.status || 'active',
    weeklySentFor: u.weeklySentFor || null,
    sentAt: ((u.evals || {})[week] || {}).sentAt || null
  }, ev, t, { attendance: auto.attendance, habit: auto.habit, auto });
}

// ─── ADMIN: EVALUATIONS ───────────────────────────────────────────────────
app.get('/api/admin/evaluations', adminAuth, (req, res) => {
  const week = weekStartFromId(req.query.week) ? String(req.query.week) : currentWeekId();
  const ws = weekStartFromId(week);
  const students = Object.values(db.users).map(u => evalRow(u, week, ws))
    .sort((a, b) => (a.playerName || '').localeCompare(b.playerName || '', undefined, { sensitivity: 'base' }));
  res.json({ week, weekStart: ws, weekEnd: addDaysKey(ws, 6), weekLabel: weekLabel(ws),
    currentWeek: currentWeekId(), maxTotal: 30, taskTarget: requiredTaskCount(), students });
});

app.put('/api/admin/evaluations/:email', adminAuth, (req, res) => {
  const u = db.users[(req.params.email || '').toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Student not found' });
  const b = req.body || {};
  const week = weekStartFromId(b.week) ? String(b.week) : currentWeekId();
  const ws = weekStartFromId(week);
  u.evals = u.evals || {};
  const ev = Object.assign(blankEval(), u.evals[week] || {});
  for (const f of COACH_FIELDS) {
    if (!(f in b)) continue;
    const v = b[f] === null || b[f] === '' ? null : Number(b[f]);
    if (v !== null && ![1, 3, 5].includes(v)) return res.status(400).json({ error: 'Scores must be 5, 3, 1 — or left unscored' });
    ev[f] = v;
  }
  if ('coachNote' in b) ev.coachNote = String(b.coachNote || '').slice(0, 2000);
  ev.scoredAt = new Date().toISOString();
  u.evals[week] = ev;
  saveDB();
  res.json({ ok: true, week, student: evalRow(u, week, ws) });
});

// ─── WEEKLY PROGRESS EMAIL (student-facing — NO evaluation data) ──────────
function esc(t) { return String(t == null ? '' : t).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
function buildWeeklyDigest(u, ws) {
  const dash = u.dailyDashboard || {};
  const subjects = dash._subjects || [];
  const need = requiredTaskCount();
  const auto = scoreWeek(u, ws);
  const rows = [];
  for (const date of weekDateKeys(ws)) {
    const d = dash[date] || {};
    const ticks = Object.values(d.tasks || {}).filter(Boolean).length;
    const learned = d.subjLearned || {};
    const learnedList = Object.keys(learned).filter(k => String(learned[k] || '').trim())
      .map(k => ({ name: (subjects.find(s => s.id === k) || {}).name || 'Class', text: String(learned[k]).trim() }));
    const win = String(d.win || '').trim();
    const journal = String(d.journal || '').trim();
    const legacy = String(d.learned || '').trim();
    if (!win && !ticks && !journal && !legacy && !learnedList.length && !(d.screen && (d.screen.mins || d.screen.locked))) continue;
    rows.push({ date, win, ticks, journal, legacy, learnedList,
      screen: d.screen || null, breath: d.breath || 0, affirm: (d.affirm || 0) >= 3 });
  }
  const cell = 'padding:7px 0;border-bottom:1px solid #EEEBFA';
  const dayHtml = rows.length ? rows.map(r => `
    <div style="margin:0 0 14px;padding:0 0 12px;border-bottom:1px solid #EEEBFA">
      <div style="font-family:Arial;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6B6780">${esc(prettyDate(r.date))}</div>
      ${r.win ? `<div style="margin-top:4px"><b style="color:#3A2E7C">Win of the day:</b> ${esc(r.win)}</div>` : ''}
      ${r.screen ? `<div style="margin-top:3px"><b style="color:#3A2E7C">Screen time:</b> ${esc(r.screen.mins || 0)} min${r.screen.locked ? ' · locked in ✅' : ' · not locked in yet'}</div>` : ''}
      <div style="margin-top:3px"><b style="color:#3A2E7C">Tasks &amp; habits:</b> ${r.ticks >= need ? r.ticks + ' ticked ✅' : r.ticks + ' of ' + need + ' ticked'}${r.affirm ? ' · affirmation ×3' : ''}${r.breath ? ' · ' + esc(r.breath) + ' min breathwork' : ''}</div>
      ${r.learnedList.length ? `<div style="margin-top:3px"><b style="color:#3A2E7C">What I learned:</b><br>${r.learnedList.map(l => '• ' + esc(l.name) + ' — ' + esc(l.text)).join('<br>')}</div>` : ''}
      ${r.legacy ? `<div style="margin-top:3px"><b style="color:#3A2E7C">Learned:</b> ${esc(r.legacy)}</div>` : ''}
      ${r.journal ? `<div style="margin-top:3px"><b style="color:#3A2E7C">Journal:</b> <i>${esc(r.journal)}</i></div>` : ''}
    </div>`).join('') : '<p style="color:#6B6780">No daily submissions were saved this week.</p>';

  const classHtml = auto.classes.length ? `<table style="width:100%;border-collapse:collapse;font-size:14px">${auto.classes.map(c => `
      <tr><td style="${cell}">${esc(prettyDate(c.date))} · ${esc(c.title)}</td>
          <td align="right" style="${cell}"><b>${c.attended ? 'attended' : (c.confirmed ? 'confirmed, not marked present' : 'missed')}</b></td></tr>`).join('')}
    </table>` : '<p style="color:#6B6780">No classes were scheduled this week.</p>';

  const subjHtml = subjects.length ? `<table style="width:100%;border-collapse:collapse;font-size:14px">${subjects.map(s => `
      <tr><td style="${cell}">${esc(s.name)}</td><td align="right" style="${cell}"><b>${esc(s.grade || '—')}</b>${s.hw ? ' <span style="color:#6B6780">· ' + esc(s.hw) + (s.hwDone ? ' ✅' : '') + '</span>' : ''}</td></tr>`).join('')}
    </table>` : '';

  const body = `
    <p>Here's everything ${esc(u.playerName)} saved in the portal this week — <b>${esc(weekLabel(ws))}</b>.</p>
    <table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px">
      <tr><td style="${cell}">Days with a submission</td><td align="right" style="${cell}"><b>${auto.submittedDays} of 7</b></td></tr>
      <tr><td style="${cell}">Tasks checked off</td><td align="right" style="${cell}"><b>${auto.taskTicks}</b></td></tr>
      <tr><td style="${cell}">Journal entries</td><td align="right" style="${cell}"><b>${auto.journalDays}</b></td></tr>
      <tr><td style="${cell}">Screen time logged</td><td align="right" style="${cell}"><b>${auto.screenMins} min</b></td></tr>
      <tr><td style="${cell}">Classes attended</td><td align="right" style="${cell}"><b>${auto.attended} of ${auto.expected}</b></td></tr>
      <tr><td style="padding:7px 0">Game day</td><td align="right" style="padding:7px 0"><b>${seasonDayFor(u) === null ? 'Season starts soon' : 'Day ' + esc(seasonDayFor(u))} · ${esc(u.streak || 0)}-day streak</b></td></tr>
    </table>
    <h3 style="color:#3A2E7C;font-size:15px;letter-spacing:.08em;text-transform:uppercase;margin:22px 0 8px">Day by day</h3>
    ${dayHtml}
    <h3 style="color:#3A2E7C;font-size:15px;letter-spacing:.08em;text-transform:uppercase;margin:22px 0 8px">Classes this week</h3>
    ${classHtml}
    ${subjHtml ? `<h3 style="color:#3A2E7C;font-size:15px;letter-spacing:.08em;text-transform:uppercase;margin:22px 0 8px">School subjects</h3>${subjHtml}` : ''}
    <p style="margin-top:22px;color:#6B6780;font-size:13px">This is a progress recap, not a discussion — nothing to reply to and nothing to fix.
    Read it together, celebrate the wins, and keep going. If you need Coach, use the Parents section of the portal.</p>`;
  return { subject: (u.playerName || 'Your champion') + "'s ICA weekly progress report", html: brandEmail('This week in the Academy', body), rows: rows.length, auto };
}

// Send (or preview) the Friday recap. force = ignore the already-sent guard.
async function sendWeeklyReports(opts) {
  const o = opts || {};
  const ws = o.weekStart || weekStartKey(laToday());
  const week = weekIdFromKey(ws);
  const only = o.only ? String(o.only).toLowerCase() : null;
  const results = [];
  for (const u of Object.values(db.users)) {
    if (only && u.email !== only) continue;
    const digest = buildWeeklyDigest(u, ws);
    const row = { email: u.email, playerName: u.playerName, days: digest.rows, subject: digest.subject, sent: false, skipped: null };
    if (o.preview) row.html = digest.html;
    if ((u.status || 'active') !== 'active') row.skipped = 'account is not active';
    else if (u.notifyEmail === false) row.skipped = 'family turned email notifications off';
    else if (!o.force && u.weeklySentFor === week) row.skipped = 'already sent for ' + week;
    if (o.preview) { results.push(row); continue; }
    if (row.skipped) { results.push(row); continue; }
    // Freeze the auto scores into the record for this week (coach-only data).
    u.evals = u.evals || {};
    const ev = Object.assign(blankEval(), u.evals[week] || {});
    ev.attendance = digest.auto.attendance;
    ev.habit = digest.auto.habit;
    if (digest.auto.attendanceNote) ev.attendance_note = digest.auto.attendanceNote;
    const t = evalTotal(ev, digest.auto);
    ev.total = t.total; ev.maxTotal = t.maxTotal; ev.sentAt = new Date().toISOString();
    u.evals[week] = ev;
    row.sent = await sendEmail(u.email, digest.subject, digest.html);
    if (row.sent) u.weeklySentFor = week;
    else row.skipped = (lastEmail && lastEmail.error) || 'email was not accepted';
    results.push(row);
  }
  if (!o.preview) {
    db.weeklyLast = { at: new Date().toISOString(), week,
      sent: results.filter(r => r.sent).length, skipped: results.filter(r => !r.sent).length, trigger: o.trigger || 'manual' };
    saveDB();
  }
  return { week, weekStart: ws, weekLabel: weekLabel(ws), results,
    sent: results.filter(r => r.sent).length, skipped: results.filter(r => !r.sent).length };
}

// Coach's button: preview or send this week's reports now.
app.post('/api/admin/weekly-report/run', adminAuth, async (req, res) => {
  const b = req.body || {};
  const ws = weekStartFromId(b.week) || weekStartKey(laToday());
  try {
    const out = await sendWeeklyReports({ weekStart: ws, only: b.email || null, force: !!b.force, preview: !!b.preview, trigger: 'admin' });
    res.json(Object.assign({ ok: true, preview: !!b.preview, lastEmail }, out));
  } catch (e) { res.status(500).json({ error: e.message || 'Weekly report failed' }); }
});

// ─── SCHEDULER: Fridays 08:00 America/Los_Angeles (no new npm deps) ───────
// Ticks every 5 minutes, compares Coach's local Pacific time, and relies on
// user.weeklySentFor so a tick inside the same hour can never double-send.
let weeklyTickBusy = false;
async function weeklyTick() {
  if (weeklyTickBusy) return;
  weeklyTickBusy = true;
  try {
    const t = laNow();
    if (t.dow === 5 && t.hour === 8) {
      const week = weekIdFromKey(weekStartKey(t.key));
      const due = Object.values(db.users).some(u => (u.status || 'active') === 'active' && u.notifyEmail !== false && u.weeklySentFor !== week);
      if (due) {
        const out = await sendWeeklyReports({ trigger: 'schedule' });
        console.log('Weekly progress reports (' + out.week + '): sent ' + out.sent + ', skipped ' + out.skipped);
      }
    }
  } catch (e) { console.error('weekly report tick failed:', e.message); }
  finally { weeklyTickBusy = false; }
}
setInterval(weeklyTick, 5 * 60 * 1000);
setTimeout(weeklyTick, 60 * 1000);   // also check a minute after boot/redeploy

app.get('/', (req, res) => res.json({ ok: true, service: 'ICA backend v5',
  // booleans only — never the values themselves. Lets Coach confirm setup at a glance.
  email: !!process.env.RESEND_API_KEY, signup: !!process.env.SIGNUP_SECRET }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ICA backend v2 listening on ' + PORT));
