const admin = require('../lib/adminOps');
const auth = require('../lib/auth');

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function handlePost(req, res) {
  const { action } = req.body || {};
  let result;
  try {
    switch (action) {
      case 'add-site':
        result = await admin.addSite(req.body.name, req.body.lat, req.body.lng, req.body.radius);
        break;
      case 'update-site':
        result = await admin.updateSite(req.body.id, req.body.name, req.body.lat, req.body.lng, req.body.radius);
        break;
      case 'retire-site':
        result = await admin.setSiteActive(req.body.id, false);
        break;
      case 'reactivate-site':
        result = await admin.setSiteActive(req.body.id, true);
        break;
      case 'add-supervisor':
        result = await admin.addSupervisor(req.body.name, 'telegram', req.body.chatId);
        break;
      case 'update-supervisor':
        result = await admin.updateSupervisor(req.body.id, req.body.name, req.body.chatId);
        break;
      case 'retire-supervisor':
        result = await admin.setSupervisorActive(req.body.id, false);
        break;
      case 'reactivate-supervisor':
        result = await admin.setSupervisorActive(req.body.id, true);
        break;
      case 'assign':
        result = await admin.assignSupervisorSite(req.body.supervisorId, req.body.siteId || null);
        break;
      case 'add-user':
        result = await auth.createUser(req.body.username, req.body.password, req.body.role);
        break;
      case 'reset-password':
        result = await auth.resetPassword(req.body.id, req.body.password);
        break;
      case 'disable-user':
        result = await auth.setUserActive(req.body.id, false);
        break;
      case 'enable-user':
        result = await auth.setUserActive(req.body.id, true);
        break;
      default:
        result = { ok: false, message: 'Unknown action.' };
    }
  } catch (err) {
    console.error('admin action failed:', err);
    result = { ok: false, message: 'Something went wrong on the server — nothing was saved.' };
  }

  const param = result.ok ? `msg=${encodeURIComponent(result.message)}` : `err=${encodeURIComponent(result.message)}`;
  res.writeHead(302, { Location: `/admin?${param}` });
  res.end();
}

async function handleGet(req, res, user) {
  const sites = await admin.listAllSites();
  const supervisors = await admin.listAllSupervisors();
  const users = await auth.listUsers();
  const activeSites = sites.filter(s => s.active);

  const banner = req.query.msg
    ? `<div class="banner ok">✅ ${esc(req.query.msg)}</div>`
    : req.query.err
    ? `<div class="banner err">⚠️ ${esc(req.query.err)}</div>`
    : '';

  const siteRows = sites.map(s => `
    <tr class="${s.active ? '' : 'retired'}">
      <form method="POST" action="/admin">
        <input type="hidden" name="action" value="update-site">
        <input type="hidden" name="id" value="${s.id}">
        <td><input name="name" value="${esc(s.name)}" ${s.active ? '' : 'disabled'}></td>
        <td><input name="lat" value="${s.latitude}" size="10" ${s.active ? '' : 'disabled'}></td>
        <td><input name="lng" value="${s.longitude}" size="10" ${s.active ? '' : 'disabled'}></td>
        <td><input name="radius" value="${s.geofence_radius_m || 300}" size="5" ${s.active ? '' : 'disabled'}></td>
        <td class="actions">
          ${s.active ? `<button type="submit">Save</button>` : ''}
        </td>
      </form>
      <td class="actions">
        <form method="POST" action="/admin" onsubmit="return confirm('${s.active ? 'Retire' : 'Reactivate'} ${esc(s.name)}?')">
          <input type="hidden" name="action" value="${s.active ? 'retire-site' : 'reactivate-site'}">
          <input type="hidden" name="id" value="${s.id}">
          <button type="submit" class="${s.active ? 'btn-warn' : 'btn-ok'}">${s.active ? 'Retire' : 'Reactivate'}</button>
        </form>
      </td>
    </tr>`).join('');

  const siteOptionsFor = (currentId) => `<option value="">— none —</option>` + activeSites.map(s =>
    `<option value="${s.id}" ${currentId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

  const supRows = supervisors.map(s => `
    <tr class="${s.active ? '' : 'retired'}">
      <form method="POST" action="/admin">
        <input type="hidden" name="action" value="update-supervisor">
        <input type="hidden" name="id" value="${s.id}">
        <td><input name="name" value="${esc(s.name)}" ${s.active ? '' : 'disabled'}></td>
        <td><input name="chatId" value="${esc(s.telegram_chat_id || '')}" ${s.active ? '' : 'disabled'}></td>
        <td class="actions">${s.active ? `<button type="submit">Save</button>` : ''}</td>
      </form>
      <form method="POST" action="/admin">
        <input type="hidden" name="action" value="assign">
        <input type="hidden" name="supervisorId" value="${s.id}">
        <td>
          <select name="siteId" ${s.active ? 'onchange="this.form.submit()"' : 'disabled'}>
            ${siteOptionsFor(s.default_site_id)}
          </select>
        </td>
      </form>
      <td class="actions">
        <form method="POST" action="/admin" onsubmit="return confirm('${s.active ? 'Retire' : 'Reactivate'} ${esc(s.name)}?')">
          <input type="hidden" name="action" value="${s.active ? 'retire-supervisor' : 'reactivate-supervisor'}">
          <input type="hidden" name="id" value="${s.id}">
          <button type="submit" class="${s.active ? 'btn-warn' : 'btn-ok'}">${s.active ? 'Retire' : 'Reactivate'}</button>
        </form>
      </td>
    </tr>`).join('');

  // Users table: the buttons/inputs point at small standalone forms below
  // the table (via the `form` attribute), which is valid HTML — unlike
  // wrapping <td>s in forms.
  const userRows = users.length ? users.map(u => `
    <tr class="${u.active ? '' : 'retired'}">
      <td>${esc(u.username)}</td>
      <td>${esc(u.role)}</td>
      <td>${u.active ? 'Active' : 'Disabled'}</td>
      <td class="actions">
        <input form="rp-${u.id}" type="password" name="password" placeholder="new password (min 8)" minlength="8" maxlength="128" autocomplete="new-password" required style="width:190px">
        <button form="rp-${u.id}" type="submit">Reset password</button>
      </td>
      <td class="actions">
        <button form="tg-${u.id}" type="submit" class="${u.active ? 'btn-warn' : 'btn-ok'}">${u.active ? 'Disable' : 'Enable'}</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="5" style="color:#888">No extra users yet — add one above.</td></tr>`;

  const userForms = users.map(u => `
    <form id="rp-${u.id}" method="POST" action="/admin"><input type="hidden" name="action" value="reset-password"><input type="hidden" name="id" value="${u.id}"></form>
    <form id="tg-${u.id}" method="POST" action="/admin" onsubmit="return confirm('${u.active ? 'Disable' : 'Enable'} ${esc(u.username)}?')"><input type="hidden" name="action" value="${u.active ? 'disable-user' : 'enable-user'}"><input type="hidden" name="id" value="${u.id}"></form>`).join('');

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RkICS Admin</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; margin: 0; padding: 24px; background: #f4f5f7; color: #1f2328; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 15px; margin: 28px 0 10px; }
  a.top-link { font-size: 13px; }
  .banner { padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; }
  .banner.ok { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
  .banner.err { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #eee; text-align: left; }
  th { background: #f0f1f3; font-weight: 600; }
  tr.retired { background: #fafafa; opacity: 0.6; }
  input, select { padding: 5px 7px; border: 1px solid #ccc; border-radius: 5px; font-size: 13px; width: 100%; box-sizing: border-box; }
  input:disabled, select:disabled { background: #f4f4f4; color: #999; }
  button { background: #2563eb; color: #fff; border: none; padding: 6px 12px; border-radius: 5px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  button.btn-warn { background: #dc2626; }
  button.btn-ok { background: #16a34a; }
  .actions { white-space: nowrap; }
  .add-form { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 14px; display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px; }
  .add-form div { min-width: 120px; }
  .add-form label { display: block; font-size: 11px; color: #666; margin-bottom: 3px; }
  .hint { color: #888; font-size: 12px; margin: 4px 0 14px; }
</style></head>
<body>
  <h1>RkICS Admin</h1>
  <div class="hint"><a class="top-link" href="/dashboard">← Back to history/reports dashboard</a> · Signed in as <b>${esc(user.username)}</b></div>
  ${banner}

  <h2>Add a new site</h2>
  <form class="add-form" method="POST" action="/admin">
    <input type="hidden" name="action" value="add-site">
    <div><label>Name</label><input name="name" required></div>
    <div><label>Latitude</label><input name="lat" required placeholder="17.4329"></div>
    <div><label>Longitude</label><input name="lng" required placeholder="78.3335"></div>
    <div><label>Radius (m)</label><input name="radius" value="300"></div>
    <div><button type="submit">Add Site</button></div>
  </form>

  <h2>Sites (${sites.length})</h2>
  <table>
    <tr><th>Name</th><th>Latitude</th><th>Longitude</th><th>Radius (m)</th><th></th><th></th></tr>
    ${siteRows}
  </table>

  <h2>Add a new supervisor</h2>
  <form class="add-form" method="POST" action="/admin">
    <input type="hidden" name="action" value="add-supervisor">
    <div><label>Name</label><input name="name" required></div>
    <div><label>Telegram chat ID</label><input name="chatId" required placeholder="Have them /start the bot first"></div>
    <div><button type="submit">Add Supervisor</button></div>
  </form>

  <h2>Supervisors (${supervisors.length})</h2>
  <table>
    <tr><th>Name</th><th>Telegram Chat ID</th><th>Usual Site</th><th></th></tr>
    ${supRows}
  </table>

  <h2>Dashboard users (who can log in to the website)</h2>
  <div class="hint"><b>Viewer</b> = can see history, charts and Excel export (good for the office clerk). <b>Admin</b> = also this page. Your main login from Vercel always works as admin and can't be disabled here. Passwords are stored scrambled — nobody can read one back, so if someone forgets theirs, just reset it.</div>
  <form class="add-form" method="POST" action="/admin" autocomplete="off">
    <input type="hidden" name="action" value="add-user">
    <div><label>Username</label><input name="username" required pattern="[A-Za-z0-9._-]{3,32}" title="3-32 characters: letters, numbers, dot, dash or underscore" placeholder="e.g. clerk1"></div>
    <div><label>Password (min 8)</label><input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></div>
    <div><label>Role</label><select name="role"><option value="viewer" selected>Viewer (view only)</option><option value="admin">Admin (full access)</option></select></div>
    <div><button type="submit">Add User</button></div>
  </form>
  <table>
    <tr><th>Username</th><th>Role</th><th>Status</th><th>Reset password</th><th></th></tr>
    ${userRows}
  </table>
  ${userForms}
</body></html>`);
}

module.exports = async (req, res) => {
  const user = await auth.requireAuth(req, res, 'admin');
  if (!user) return;
  if (req.method === 'POST') return handlePost(req, res);
  return handleGet(req, res, user);
};
