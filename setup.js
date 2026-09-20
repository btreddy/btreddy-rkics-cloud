/**
 * Admin CLI for the cloud version — run from ANY machine with the .env
 * pointing at your Supabase DATABASE_URL. No need to be on a specific PC.
 *
 *   node setup.js add-site "Kompally Site" 17.5453 78.4894 300
 *   node setup.js update-site "old name" "new name" 17.5 78.4 300
 *   node setup.js add-supervisor "Ravi Kumar" telegram 987654321
 *   node setup.js delete-supervisor "<telegram chat ID>"
 *   node setup.js assign "Ravi Kumar" "Kompally Site"
 *   node setup.js delete-site "Kompally Site"
 *   node setup.js list
 */
require('dotenv').config();
const pool = require('./lib/db');

const [,, cmd, ...args] = process.argv;

async function addSite(name, lat, lng, radius) {
  const { rows } = await pool.query(`SELECT * FROM sites WHERE name ILIKE $1`, [name]);
  if (rows[0]) {
    console.error(`A site named "${rows[0].name}" already exists (id ${rows[0].id}).`);
    console.error(`If this is the same site with corrected coordinates, use:\n  node setup.js update-site "${rows[0].name}" "${name}" ${lat} ${lng} ${radius || ''}`);
    return;
  }
  await pool.query(`INSERT INTO sites (name, latitude, longitude, geofence_radius_m) VALUES ($1,$2,$3,$4)`,
    [name, parseFloat(lat), parseFloat(lng), radius ? parseInt(radius, 10) : null]);
  console.log(`Site added: ${name}`);
}

async function updateSite(oldName, newName, lat, lng, radius) {
  const { rows } = await pool.query(`SELECT * FROM sites WHERE name ILIKE $1`, [oldName]);
  if (!rows[0]) return console.error(`Site "${oldName}" not found.`);
  await pool.query(`UPDATE sites SET name=$1, latitude=$2, longitude=$3, geofence_radius_m=$4 WHERE id=$5`,
    [newName, parseFloat(lat), parseFloat(lng), radius ? parseInt(radius, 10) : rows[0].geofence_radius_m, rows[0].id]);
  console.log(`Updated "${oldName}" -> "${newName}" with corrected coordinates.`);
}

async function addSupervisor(name, channel, channelId) {
  if (channel === 'telegram') {
    await pool.query(`INSERT INTO supervisors (name, telegram_chat_id) VALUES ($1,$2)`, [name, String(channelId)]);
  } else if (channel === 'whatsapp') {
    await pool.query(`INSERT INTO supervisors (name, whatsapp_number) VALUES ($1,$2)`, [name, String(channelId)]);
  } else {
    return console.error('channel must be "telegram" or "whatsapp"');
  }
  console.log(`Supervisor added: ${name} (${channel}: ${channelId})`);
}

async function deleteSupervisor(identifier) {
  let { rows } = await pool.query(`SELECT * FROM supervisors WHERE telegram_chat_id=$1 OR whatsapp_number=$1`, [identifier]);
  let sup = rows[0];

  if (!sup) {
    const matches = (await pool.query(`SELECT * FROM supervisors WHERE name ILIKE $1 AND active = TRUE`, [identifier])).rows;
    if (matches.length === 0) return console.error(`No active supervisor found matching "${identifier}".`);
    if (matches.length > 1) {
      console.error(`"${identifier}" matches ${matches.length} active supervisors — ambiguous. Use their Telegram chat ID instead:`);
      matches.forEach(m => console.error(`  id ${m.id} — telegram: ${m.telegram_chat_id || '—'}`));
      return;
    }
    sup = matches[0];
  }
  if (!sup.active) return console.error(`"${sup.name}" (id ${sup.id}) is already retired.`);

  await pool.query(`UPDATE supervisors SET active = FALSE WHERE id = $1`, [sup.id]);
  const count = (await pool.query(`SELECT COUNT(*) c FROM checkins WHERE supervisor_id=$1`, [sup.id])).rows[0].c;
  console.log(`Retired "${sup.name}" (id ${sup.id}) — won't respond to bot commands. ${count} past check-in(s) kept for records.`);
}

async function assign(supName, siteName) {
  const sup = (await pool.query(`SELECT * FROM supervisors WHERE name ILIKE $1`, [supName])).rows[0];
  const site = (await pool.query(`SELECT * FROM sites WHERE name ILIKE $1`, [siteName])).rows[0];
  if (!sup || !site) return console.error('Supervisor or site not found');
  await pool.query(`UPDATE supervisors SET default_site_id = $1 WHERE id = $2`, [site.id, sup.id]);
  console.log(`${supName}'s usual site set to ${site.name}.`);
}

async function deleteSite(siteName) {
  const site = (await pool.query(`SELECT * FROM sites WHERE name ILIKE $1`, [siteName])).rows[0];
  if (!site) return console.error(`Site "${siteName}" not found.`);
  const using = (await pool.query(`SELECT name FROM supervisors WHERE default_site_id=$1`, [site.id])).rows;
  if (using.length > 0) {
    console.error(`Can't retire "${siteName}" — still the usual site for: ${using.map(s => s.name).join(', ')}.`);
    return;
  }
  await pool.query(`UPDATE sites SET active = FALSE WHERE id = $1`, [site.id]);
  console.log(`Site "${siteName}" retired.`);
}

async function list() {
  console.log('\n--- Active Supervisors ---');
  console.table((await pool.query(`
    SELECT sup.id, sup.name, sup.telegram_chat_id, s.name AS usual_site
    FROM supervisors sup LEFT JOIN sites s ON s.id = sup.default_site_id WHERE sup.active = TRUE
  `)).rows);
  const inactiveSups = (await pool.query(`SELECT id, name, telegram_chat_id FROM supervisors WHERE active = FALSE`)).rows;
  if (inactiveSups.length) { console.log('\n--- Retired Supervisors ---'); console.table(inactiveSups); }

  console.log('\n--- Active Sites ---');
  console.table((await pool.query(`SELECT id, name, latitude, longitude, geofence_radius_m FROM sites WHERE active = TRUE`)).rows);
  const inactiveSites = (await pool.query(`SELECT id, name FROM sites WHERE active = FALSE`)).rows;
  if (inactiveSites.length) { console.log('\n--- Retired Sites ---'); console.table(inactiveSites); }
}

(async () => {
  switch (cmd) {
    case 'add-site': await addSite(...args); break;
    case 'update-site': await updateSite(...args); break;
    case 'add-supervisor': await addSupervisor(...args); break;
    case 'delete-supervisor': await deleteSupervisor(...args); break;
    case 'assign': await assign(...args); break;
    case 'delete-site': await deleteSite(...args); break;
    case 'list': await list(); break;
    default:
      console.log('Usage:\n' +
        '  node setup.js add-site "<name>" <lat> <lng> [radius_m]\n' +
        '  node setup.js update-site "<old name>" "<new name>" <lat> <lng> [radius_m]\n' +
        '  node setup.js add-supervisor "<name>" telegram|whatsapp <chat_id_or_number>\n' +
        '  node setup.js delete-supervisor "<name or telegram chat ID>"\n' +
        '  node setup.js assign "<supervisor name>" "<usual site name>"\n' +
        '  node setup.js delete-site "<site name>"\n' +
        '  node setup.js list');
  }
  await pool.end();
})();
