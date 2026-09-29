const crypto = require('crypto');
const pool = require('./db');

// Two roles:
//   viewer — dashboard, charts, Excel export (e.g. office clerk)
//   admin  — everything above + the /admin page
// The main login set in Vercel (DASHBOARD_USER / DASHBOARD_PASS) is always
// an admin and works even if the database is unreachable, so it can never
// be locked out by anything done on the users page.
const ROLE_RANK = { viewer: 1, admin: 2 };
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','viewer')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  tableReady = true;
}

// Passwords are stored only as salted scrypt hashes — nobody (including
// you) can read one back. A forgotten password is simply reset.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const DUMMY_HASH = hashPassword('not-a-real-password');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function authenticate(req) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return null;

  // Split at the FIRST colon only, so passwords may themselves contain ":".
  const decoded = Buffer.from(encoded, 'base64').toString();
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const username = decoded.slice(0, i);
  const password = decoded.slice(i + 1);

  const masterUser = process.env.DASHBOARD_USER || 'admin';
  const masterPass = process.env.DASHBOARD_PASS || 'change-me';
  if (safeEqual(username, masterUser) && safeEqual(password, masterPass)) {
    return { username: masterUser, role: 'admin', master: true };
  }

  await ensureTable();
  const { rows } = await pool.query(
    `SELECT * FROM dashboard_users WHERE username = $1 AND active = TRUE`, [username.toLowerCase()]
  );
  const u = rows[0];
  if (!u) { verifyPassword(password, DUMMY_HASH); return null; } // keep timing similar
  if (!verifyPassword(password, u.password_hash)) return null;
  return { username: u.username, role: u.role, master: false };
}

// Returns the signed-in user, or null after having already sent a 401/403.
async function requireAuth(req, res, minRole = 'viewer') {
  const user = await authenticate(req);
  if (!user) {
    res.setHeader('WWW-Authenticate', 'Basic realm="RkICS Dashboard"');
    res.status(401).send('Authentication required.');
    return null;
  }
  if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
    res.setHeader('Content-Type', 'text/html');
    res.status(403).send(
      `<div style="font-family:Arial,sans-serif;padding:32px">` +
      `<h3>Admins only</h3><p>You're signed in as <b>${user.username}</b> (${user.role}), ` +
      `and this page needs an admin login.</p><p><a href="/dashboard">← Back to the dashboard</a></p></div>`
    );
    return null;
  }
  return user;
}

// ---- user management (used by the /admin page) ----

async function listUsers() {
  await ensureTable();
  const { rows } = await pool.query(`SELECT id, username, role, active FROM dashboard_users ORDER BY active DESC, username`);
  return rows;
}

async function createUser(username, password, role) {
  username = (username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return { ok: false, message: 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.' };
  if (username === (process.env.DASHBOARD_USER || 'admin').toLowerCase()) return { ok: false, message: 'That username is reserved for the main admin login.' };
  if (!password || password.length < 8) return { ok: false, message: 'Password must be at least 8 characters.' };
  if (password.length > 128) return { ok: false, message: 'Password is too long (max 128 characters).' };
  if (!ROLE_RANK[role]) return { ok: false, message: 'Role must be viewer or admin.' };

  await ensureTable();
  try {
    await pool.query(`INSERT INTO dashboard_users (username, password_hash, role) VALUES ($1,$2,$3)`,
      [username, hashPassword(password), role]);
  } catch (err) {
    if (err.code === '23505') return { ok: false, message: `A user named "${username}" already exists.` };
    throw err;
  }
  return { ok: true, message: `User "${username}" created as ${role}.` };
}

async function resetPassword(id, password) {
  if (!password || password.length < 8) return { ok: false, message: 'Password must be at least 8 characters.' };
  if (password.length > 128) return { ok: false, message: 'Password is too long (max 128 characters).' };
  await ensureTable();
  const { rows } = await pool.query(`UPDATE dashboard_users SET password_hash = $1 WHERE id = $2 RETURNING username`,
    [hashPassword(password), id]);
  if (!rows[0]) return { ok: false, message: 'User not found.' };
  return { ok: true, message: `Password reset for "${rows[0].username}".` };
}

async function setUserActive(id, active) {
  await ensureTable();
  const { rows } = await pool.query(`UPDATE dashboard_users SET active = $1 WHERE id = $2 RETURNING username`, [active, id]);
  if (!rows[0]) return { ok: false, message: 'User not found.' };
  return { ok: true, message: `User "${rows[0].username}" ${active ? 'enabled' : 'disabled — can no longer log in'}.` };
}

module.exports = { requireAuth, listUsers, createUser, resetPassword, setUserActive };
