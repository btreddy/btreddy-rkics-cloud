const pool = require('./db');

// Every function returns { ok: boolean, message: string } instead of
// console.log/error directly — so the same logic can be used by both the
// CLI (setup.js, which prints the message) and the web dashboard (which
// shows it as a banner), without duplicating the business rules in two
// places and having them quietly drift apart over time.

async function listAllSites() {
  const { rows } = await pool.query(`SELECT * FROM sites ORDER BY active DESC, name`);
  return rows;
}

async function listAllSupervisors() {
  const { rows } = await pool.query(`
    SELECT sup.*, s.name AS usual_site_name
    FROM supervisors sup LEFT JOIN sites s ON s.id = sup.default_site_id
    ORDER BY sup.active DESC, sup.name
  `);
  return rows;
}

async function addSite(name, lat, lng, radius) {
  name = (name || '').trim();
  if (!name) return { ok: false, message: 'Site name is required.' };
  if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) return { ok: false, message: 'Latitude and longitude must be numbers.' };

  const existing = (await pool.query(`SELECT id, name FROM sites WHERE name ILIKE $1`, [name])).rows[0];
  if (existing) {
    return { ok: false, message: `A site named "${existing.name}" already exists — edit that one instead of adding a duplicate.` };
  }
  await pool.query(`INSERT INTO sites (name, latitude, longitude, geofence_radius_m) VALUES ($1,$2,$3,$4)`,
    [name, parseFloat(lat), parseFloat(lng), radius ? parseInt(radius, 10) : 300]);
  return { ok: true, message: `Site "${name}" added.` };
}

async function updateSite(id, name, lat, lng, radius) {
  name = (name || '').trim();
  if (!name) return { ok: false, message: 'Site name is required.' };
  if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) return { ok: false, message: 'Latitude and longitude must be numbers.' };

  const dup = (await pool.query(`SELECT id FROM sites WHERE name ILIKE $1 AND id != $2`, [name, id])).rows[0];
  if (dup) return { ok: false, message: `Another site is already named "${name}" — pick a different name.` };

  await pool.query(`UPDATE sites SET name=$1, latitude=$2, longitude=$3, geofence_radius_m=$4 WHERE id=$5`,
    [name, parseFloat(lat), parseFloat(lng), radius ? parseInt(radius, 10) : 300, id]);
  return { ok: true, message: `Site "${name}" updated.` };
}

async function setSiteActive(id, active) {
  const site = (await pool.query(`SELECT * FROM sites WHERE id=$1`, [id])).rows[0];
  if (!site) return { ok: false, message: 'Site not found.' };

  if (!active) {
    const using = (await pool.query(`SELECT name FROM supervisors WHERE default_site_id=$1 AND active=TRUE`, [id])).rows;
    if (using.length > 0) {
      return { ok: false, message: `Can't retire "${site.name}" — still the usual site for: ${using.map(s => s.name).join(', ')}. Reassign them first.` };
    }
  }
  await pool.query(`UPDATE sites SET active=$1 WHERE id=$2`, [active, id]);
  return { ok: true, message: `Site "${site.name}" ${active ? 'reactivated' : 'retired'}.` };
}

async function addSupervisor(name, channel, channelId) {
  name = (name || '').trim();
  channelId = (channelId || '').trim();
  if (!name) return { ok: false, message: 'Supervisor name is required.' };
  if (!channelId) return { ok: false, message: 'A Telegram chat ID is required.' };
  if (!['telegram', 'whatsapp'].includes(channel)) return { ok: false, message: 'Channel must be telegram or whatsapp.' };

  try {
    if (channel === 'telegram') {
      await pool.query(`INSERT INTO supervisors (name, telegram_chat_id) VALUES ($1,$2)`, [name, channelId]);
    } else {
      await pool.query(`INSERT INTO supervisors (name, whatsapp_number) VALUES ($1,$2)`, [name, channelId]);
    }
    return { ok: true, message: `Supervisor "${name}" added.` };
  } catch (err) {
    if (err.code === '23505') return { ok: false, message: `That chat ID is already registered to someone else.` };
    throw err;
  }
}

async function updateSupervisor(id, name, telegramChatId) {
  name = (name || '').trim();
  telegramChatId = (telegramChatId || '').trim();
  if (!name) return { ok: false, message: 'Supervisor name is required.' };
  if (!telegramChatId) return { ok: false, message: 'A Telegram chat ID is required.' };

  try {
    await pool.query(`UPDATE supervisors SET name=$1, telegram_chat_id=$2 WHERE id=$3`, [name, telegramChatId, id]);
    return { ok: true, message: `Supervisor "${name}" updated.` };
  } catch (err) {
    if (err.code === '23505') return { ok: false, message: `That chat ID is already registered to someone else.` };
    throw err;
  }
}

async function setSupervisorActive(id, active) {
  const sup = (await pool.query(`SELECT * FROM supervisors WHERE id=$1`, [id])).rows[0];
  if (!sup) return { ok: false, message: 'Supervisor not found.' };
  await pool.query(`UPDATE supervisors SET active=$1 WHERE id=$2`, [active, id]);
  return { ok: true, message: `"${sup.name}" ${active ? 'reactivated' : 'retired'} — ${active ? 'can now use bot commands again' : "won't respond to bot commands, past history kept"}.` };
}

async function assignSupervisorSite(supervisorId, siteId) {
  const sup = (await pool.query(`SELECT * FROM supervisors WHERE id=$1`, [supervisorId])).rows[0];
  if (!sup) return { ok: false, message: 'Supervisor not found.' };
  await pool.query(`UPDATE supervisors SET default_site_id=$1 WHERE id=$2`, [siteId || null, supervisorId]);
  if (!siteId) return { ok: true, message: `Cleared ${sup.name}'s usual site.` };
  const site = (await pool.query(`SELECT name FROM sites WHERE id=$1`, [siteId])).rows[0];
  return { ok: true, message: `${sup.name}'s usual site set to ${site.name}.` };
}

module.exports = {
  listAllSites, listAllSupervisors, addSite, updateSite, setSiteActive,
  addSupervisor, updateSupervisor, setSupervisorActive, assignSupervisorSite,
};
