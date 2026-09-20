const XLSX = require('xlsx');
const { requireAuth, parseFilters, getCheckins, getDprs, fmtIST } = require('../lib/dashboardData');

module.exports = async (req, res) => {
  if (!requireAuth(req, res)) return;

  const filters = parseFilters(req.query);
  const checkins = await getCheckins(filters);
  const dprs = await getDprs(filters);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(checkins.map(c => ({
    'Time (IST)': fmtIST(c.created_at), Supervisor: c.supervisor, Site: c.site, Type: c.type,
    Flagged: c.flagged ? 'Yes' : 'No', 'Flag Reason': c.flag_reason || '',
    'Other/Out-of-Station Reason': c.reason || '', Channel: c.channel,
    Latitude: c.latitude, Longitude: c.longitude, 'Distance from site (m)': c.distance_from_site_m,
  }))), 'Check-ins');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dprs.map(d => ({
    'Time (IST)': fmtIST(d.created_at), Supervisor: d.supervisor, Site: d.site,
    Type: d.content_type, Content: d.content, Channel: d.channel,
  }))), 'DPR Reports');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="rkics_history_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.status(200).send(buffer);
};
