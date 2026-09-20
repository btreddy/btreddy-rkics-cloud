const {
  requireAuth, parseFilters, getFilterOptions, getCheckins, getDprs,
  fmtIST, computeWorkingHours, summarizeWorkingHours,
} = require('../lib/dashboardData');

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  const filters = parseFilters(req.query);
  const { supervisors, sites } = await getFilterOptions();
  const checkins = await getCheckins(filters);
  const dprs = await getDprs(filters);
  const hoursSummary = summarizeWorkingHours(computeWorkingHours(checkins));

  const qs = new URLSearchParams(req.query).toString();
  const supOptions = supervisors.map(s => `<option value="${s.id}" ${filters.supervisorId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const siteOptions = sites.map(s => `<option value="${s.id}" ${filters.siteId === s.id ? 'selected' : ''}>${esc(s.name)}${s.active ? '' : ' (retired)'}</option>`).join('');

  const checkinRows = checkins.map(c => `
    <tr class="${c.flagged ? 'flagged' : ''}">
      <td>${esc(fmtIST(c.created_at))}</td><td>${esc(c.supervisor)}</td><td>${esc(c.site)}</td><td>${esc(c.type)}</td>
      <td>${c.flagged ? '⚠️ ' + esc(c.flag_reason || '') : ''}</td><td>${esc(c.reason || '')}</td><td>${esc(c.channel)}</td>
    </tr>`).join('');

  const dprRows = dprs.map(d => `
    <tr><td>${esc(fmtIST(d.created_at))}</td><td>${esc(d.supervisor)}</td><td>${esc(d.site)}</td><td>${esc(d.content_type)}</td><td>${esc(d.content)}</td></tr>`).join('');

  const hoursRows = hoursSummary.map(h => `<tr><td>${esc(h.supervisor)}</td><td>${h.days}</td><td>${h.avgHours}</td><td>${h.totalHours}</td></tr>`).join('');
  const chartLabels = JSON.stringify(hoursSummary.map(h => h.supervisor));
  const chartData = JSON.stringify(hoursSummary.map(h => h.avgHours));

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RkICS Site Tracker Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; margin: 0; padding: 24px; background: #f4f5f7; color: #1f2328; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; margin-bottom: 20px; font-size: 13px; }
  form { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 20px; display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
  label { display: block; font-size: 12px; color: #555; margin-bottom: 4px; }
  input, select { padding: 6px 8px; border: 1px solid #ccc; border-radius: 5px; font-size: 13px; }
  button, .btn { background: #2563eb; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-block; }
  .btn-export { background: #16a34a; margin-left: 8px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; margin-bottom: 28px; font-size: 13px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #eee; text-align: left; }
  th { background: #f0f1f3; font-weight: 600; }
  tr.flagged { background: #fff7ed; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  .empty { color: #888; padding: 16px; text-align: center; }
  .chart-box { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .chart-note { color: #888; font-size: 12px; margin-bottom: 20px; }
</style></head>
<body>
  <h1>RkICS Site Tracker — Dashboard</h1>
  <div class="sub">Check-in and DPR history. Filter below, or export the filtered view to Excel.</div>
  <form method="get" action="/dashboard">
    <div><label>From</label><input type="date" name="from" value="${esc(filters.from || '')}"></div>
    <div><label>To</label><input type="date" name="to" value="${esc(filters.to || '')}"></div>
    <div><label>Supervisor</label><select name="supervisor"><option value="">All</option>${supOptions}</select></div>
    <div><label>Site</label><select name="site"><option value="">All</option>${siteOptions}</select></div>
    <div><button type="submit">Apply Filters</button></div>
    <div><a class="btn btn-export" href="/api/export?${esc(qs)}">⬇ Export to Excel</a></div>
  </form>

  <h2>Average Working Hours per Day (by supervisor, for this filter)</h2>
  ${hoursSummary.length ? `
    <div class="chart-box"><canvas id="hoursChart" height="90"></canvas></div>
    <div class="chart-note">Calculated from paired IN → OUT check-ins per day. Days with a check-in but no matching check-out aren't counted.</div>
    <table><tr><th>Supervisor</th><th>Days with complete IN/OUT</th><th>Avg hours/day</th><th>Total hours</th></tr>${hoursRows}</table>
  ` : `<div class="empty">Not enough paired IN/OUT check-ins in this filter to calculate working hours.</div>`}

  <h2>Check-ins (${checkins.length})</h2>
  ${checkins.length ? `<table><tr><th>Time</th><th>Supervisor</th><th>Site</th><th>Type</th><th>Flag</th><th>Reason</th><th>Channel</th></tr>${checkinRows}</table>` : `<div class="empty">No check-ins for this filter.</div>`}

  <h2>DPR Reports (${dprs.length})</h2>
  ${dprs.length ? `<table><tr><th>Time</th><th>Supervisor</th><th>Site</th><th>Type</th><th>Content</th></tr>${dprRows}</table>` : `<div class="empty">No DPR reports for this filter.</div>`}

<script>
  if (document.getElementById('hoursChart')) {
    new Chart(document.getElementById('hoursChart'), {
      type: 'bar',
      data: { labels: ${chartLabels}, datasets: [{ label: 'Avg hours/day', data: ${chartData}, backgroundColor: '#2563eb' }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: 'Hours' } } } }
    });
  }
</script>
</body></html>`);
};
