/**
 * Admin CLI for the cloud version — run from ANY machine with the .env
 * pointing at your Supabase DATABASE_URL. No need to be on a specific PC.
 *
 * Since the web dashboard at /admin now covers all of this too, this CLI
 * is mainly here for scripting/bulk-loading (like adding many sites at
 * once) — day-to-day single edits are usually easier from the browser.
 *
 *   node setup.js add-site "Kompally Site" 17.5453 78.4894 300
 *   node setup.js update-site-by-name "old name" "new name" 17.5 78.4 300
 *   node setup.js add-supervisor "Ravi Kumar" telegram 987654321
 *   node setup.js delete-supervisor "<name or telegram chat ID>"
 *   node setup.js assign "Ravi Kumar" "Kompally Site"
 *   node setup.js delete-site "Kompally Site"
 *   node setup.js list
 */
require('dotenv').config();
const pool = require('./lib/db');
const admin = require('./lib/adminOps');

const [,, cmd, ...args] = process.argv;

function report(result) {
  console.log(result.ok ? result.message : `Error: ${result.message}`);
}

async function findSiteByName(name) {
  return (await pool.query(`SELECT * FROM sites WHERE name ILIKE $1`, [name])).rows[0];
}
async function findSupervisorByNameOrChatId(identifier) {
  const byChat = (await pool.query(`SELECT * FROM supervisors WHERE telegram_chat_id=$1`, [identifier])).rows[0];
  if (byChat) return byChat;
  const matches = (await pool.query(`SELECT * FROM supervisors WHERE name ILIKE $1 AND active=TRUE`, [identifier])).rows;
  if (matches.length > 1) {
    console.error(`"${identifier}" matches ${matches.length} supervisors — use their Telegram chat ID instead:`);
    matches.forEach(m => console.error(`  id ${m.id} — telegram: ${m.telegram_chat_id || '—'}`));
    return null;
  }
  return matches[0];
}

async function updateSiteByName(oldName, newName, lat, lng, radius) {
  const site = await findSiteByName(oldName);
  if (!site) return console.error(`Site "${oldName}" not found.`);
  report(await admin.updateSite(site.id, newName, lat, lng, radius));
}

async function assignByName(supName, siteName) {
  const sup = await findSupervisorByNameOrChatId(supName);
  const site = await findSiteByName(siteName);
  if (!sup) return console.error(`Supervisor "${supName}" not found.`);
  if (!site) return console.error(`Site "${siteName}" not found.`);
  report(await admin.assignSupervisorSite(sup.id, site.id));
}

async function deleteSupervisorByIdentifier(identifier) {
  const sup = await findSupervisorByNameOrChatId(identifier);
  if (!sup) return console.error(`No active supervisor found matching "${identifier}".`);
  report(await admin.setSupervisorActive(sup.id, false));
}

async function deleteSiteByName(name) {
  const site = await findSiteByName(name);
  if (!site) return console.error(`Site "${name}" not found.`);
  report(await admin.setSiteActive(site.id, false));
}

async function list() {
  console.log('\n--- Active Supervisors ---');
  console.table((await admin.listAllSupervisors()).filter(s => s.active).map(s =>
    ({ id: s.id, name: s.name, telegram_chat_id: s.telegram_chat_id, usual_site: s.usual_site_name })));
  const inactiveSups = (await admin.listAllSupervisors()).filter(s => !s.active);
  if (inactiveSups.length) { console.log('\n--- Retired Supervisors ---'); console.table(inactiveSups.map(s => ({ id: s.id, name: s.name, telegram_chat_id: s.telegram_chat_id }))); }

  console.log('\n--- Active Sites ---');
  console.table((await admin.listAllSites()).filter(s => s.active).map(s =>
    ({ id: s.id, name: s.name, latitude: s.latitude, longitude: s.longitude, geofence_radius_m: s.geofence_radius_m })));
  const inactiveSites = (await admin.listAllSites()).filter(s => !s.active);
  if (inactiveSites.length) { console.log('\n--- Retired Sites ---'); console.table(inactiveSites.map(s => ({ id: s.id, name: s.name }))); }
}

(async () => {
  switch (cmd) {
    case 'add-site': report(await admin.addSite(...args)); break;
    case 'update-site-by-name': await updateSiteByName(...args); break;
    case 'add-supervisor': {
      const [name, channel, channelId] = args;
      report(await admin.addSupervisor(name, channel, channelId));
      break;
    }
    case 'delete-supervisor': await deleteSupervisorByIdentifier(args[0]); break;
    case 'assign': await assignByName(...args); break;
    case 'delete-site': await deleteSiteByName(args[0]); break;
    case 'list': await list(); break;
    default:
      console.log('Usage:\n' +
        '  node setup.js add-site "<name>" <lat> <lng> [radius_m]\n' +
        '  node setup.js update-site-by-name "<old name>" "<new name>" <lat> <lng> [radius_m]\n' +
        '  node setup.js add-supervisor "<name>" telegram <chat_id>\n' +
        '  node setup.js delete-supervisor "<name or telegram chat ID>"\n' +
        '  node setup.js assign "<supervisor name>" "<usual site name>"\n' +
        '  node setup.js delete-site "<site name>"\n' +
        '  node setup.js list\n\n' +
        '  Or manage everything from the browser: /admin on your deployed URL.');
  }
  await pool.end();
})();
