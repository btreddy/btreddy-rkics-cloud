const pool = require('./db');
const TZ = 'Asia/Kolkata';

function checkAuth(req) {
  const user = process.env.DASHBOARD_USER || 'admin';
  const pass = process.env.DASHBOARD_PASS || 'change-me';
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
  return u === user && p === pass;
}

function requireAuth(req, res) {
  if (checkAuth(req)) return true;
  res.setHeader('WWW-Authenticate', 'Basic realm="RkICS Dashboard"');
  res.status(401).send('Authentication required.');
  return false;
}

function parseFilters(query) {
  return {
    from: query.from || null,
    to: query.to || null,
    supervisorId: query.supervisor ? parseInt(query.supervisor, 10) : null,
    siteId: query.site ? parseInt(query.site, 10) : null,
  };
}

async function getFilterOptions() {
  const supervisors = (await pool.query(`SELECT id, name FROM supervisors ORDER BY name`)).rows;
  const sites = (await pool.query(`SELECT id, name, active FROM sites ORDER BY active DESC, name`)).rows;
  return { supervisors, sites };
}

// Filters compare using the IST calendar date (fixes the old SQLite
// version's edge case where a very-early-morning IST check-in could land
// on the wrong day due to comparing raw UTC dates).
async function getCheckins(f) {
  const conditions = [];
  const params = [];
  let i = 1;
  if (f.from) { conditions.push(`(c.created_at AT TIME ZONE '${TZ}')::date >= $${i++}`); params.push(f.from); }
  if (f.to) { conditions.push(`(c.created_at AT TIME ZONE '${TZ}')::date <= $${i++}`); params.push(f.to); }
  if (f.supervisorId) { conditions.push(`c.supervisor_id = $${i++}`); params.push(f.supervisorId); }
  if (f.siteId) { conditions.push(`c.site_id = $${i++}`); params.push(f.siteId); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await pool.query(`
    SELECT c.id, sup.name AS supervisor, COALESCE(s.name, 'Other / Out of Station') AS site,
           c.type, c.created_at, c.latitude, c.longitude, c.distance_from_site_m,
           c.flagged, c.flag_reason, c.channel, c.reason
    FROM checkins c
    JOIN supervisors sup ON sup.id = c.supervisor_id
    LEFT JOIN sites s ON s.id = c.site_id
    ${where}
    ORDER BY c.created_at DESC LIMIT 2000
  `, params);
  return rows;
}

async function getDprs(f) {
  const conditions = [];
  const params = [];
  let i = 1;
  if (f.from) { conditions.push(`(d.created_at AT TIME ZONE '${TZ}')::date >= $${i++}`); params.push(f.from); }
  if (f.to) { conditions.push(`(d.created_at AT TIME ZONE '${TZ}')::date <= $${i++}`); params.push(f.to); }
  if (f.supervisorId) { conditions.push(`d.supervisor_id = $${i++}`); params.push(f.supervisorId); }
  if (f.siteId) { conditions.push(`d.site_id = $${i++}`); params.push(f.siteId); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await pool.query(`
    SELECT d.id, sup.name AS supervisor, COALESCE(s.name, 'Other / Out of Station') AS site,
           d.content, d.content_type, d.channel, d.created_at
    FROM dpr_reports d
    JOIN supervisors sup ON sup.id = d.supervisor_id
    LEFT JOIN sites s ON s.id = d.site_id
    ${where}
    ORDER BY d.created_at DESC LIMIT 2000
  `, params);
  return rows;
}

function fmtIST(dateObj) {
  if (!dateObj) return '';
  return new Date(dateObj).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ });
}

function istDateKey(dateObj) {
  return new Date(dateObj).toLocaleDateString('en-CA', { timeZone: TZ });
}

function computeWorkingHours(checkins) {
  const bySupervisor = {};
  for (const c of checkins) (bySupervisor[c.supervisor] ??= []).push(c);

  const results = [];
  for (const [supervisor, rows] of Object.entries(bySupervisor)) {
    const byDate = {};
    for (const c of rows) (byDate[istDateKey(c.created_at)] ??= []).push(c);
    for (const [date, dayRows] of Object.entries(byDate)) {
      dayRows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      let openIn = null, totalMs = 0;
      for (const r of dayRows) {
        if (r.type === 'IN' && !openIn) openIn = new Date(r.created_at);
        else if (r.type === 'OUT' && openIn) { totalMs += new Date(r.created_at) - openIn; openIn = null; }
      }
      if (totalMs > 0) results.push({ supervisor, date, hours: totalMs / 3600000 });
    }
  }
  return results;
}

function summarizeWorkingHours(results) {
  const bySupervisor = {};
  for (const r of results) {
    const s = (bySupervisor[r.supervisor] ??= { totalHours: 0, days: 0 });
    s.totalHours += r.hours; s.days += 1;
  }
  return Object.entries(bySupervisor)
    .map(([supervisor, { totalHours, days }]) => ({
      supervisor, days,
      totalHours: Math.round(totalHours * 10) / 10,
      avgHours: Math.round((totalHours / days) * 10) / 10,
    }))
    .sort((a, b) => b.avgHours - a.avgHours);
}

module.exports = {
  requireAuth, parseFilters, getFilterOptions, getCheckins, getDprs,
  fmtIST, computeWorkingHours, summarizeWorkingHours,
};
