const pool = require('./db');
const { distanceMeters } = require('./geo');

const DEFAULT_RADIUS = parseInt(process.env.DEFAULT_GEOFENCE_RADIUS_M || '300', 10);
const TZ = 'Asia/Kolkata';

async function findSupervisorByChannelId(channel, channelId) {
  const col = channel === 'telegram' ? 'telegram_chat_id' : 'whatsapp_number';
  const { rows } = await pool.query(
    `SELECT * FROM supervisors WHERE ${col} = $1 AND active = TRUE`, [String(channelId)]
  );
  return rows[0] || null;
}

async function listActiveSites() {
  const { rows } = await pool.query(`SELECT * FROM sites WHERE active = TRUE ORDER BY name`);
  return rows;
}

async function getSiteById(siteId) {
  if (!siteId) return null;
  const { rows } = await pool.query(`SELECT * FROM sites WHERE id = $1`, [siteId]);
  return rows[0] || null;
}

async function getDefaultSite(supervisorId) {
  const { rows } = await pool.query(`SELECT default_site_id FROM supervisors WHERE id = $1`, [supervisorId]);
  if (!rows[0] || !rows[0].default_site_id) return null;
  return getSiteById(rows[0].default_site_id);
}

async function getLatestTodaySiteForSupervisor(supervisorId) {
  const { rows } = await pool.query(`
    SELECT site_id FROM checkins
    WHERE supervisor_id = $1 AND site_id IS NOT NULL
      AND (created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
    ORDER BY created_at DESC LIMIT 1
  `, [supervisorId]);
  return rows[0] ? getSiteById(rows[0].site_id) : null;
}

async function recordCheckin({ supervisorId, siteId, type, latitude, longitude, channel, reason }) {
  const site = siteId ? await getSiteById(siteId) : null;
  const defaultSite = await getDefaultSite(supervisorId);
  let distance = null, flagged = false, flagReason = null;

  if (site && latitude != null && longitude != null) {
    distance = distanceMeters(latitude, longitude, site.latitude, site.longitude);
    const radius = site.geofence_radius_m || DEFAULT_RADIUS;
    if (distance > radius) {
      flagged = true;
      flagReason = `${Math.round(distance)}m from ${site.name} (radius ${radius}m)`;
    }
  } else if (latitude == null) {
    flagged = true;
    flagReason = 'No location shared with check-in';
  }

  await pool.query(`
    INSERT INTO checkins (supervisor_id, site_id, type, latitude, longitude, distance_from_site_m, flagged, flag_reason, channel, reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [supervisorId, site ? site.id : null, type, latitude ?? null, longitude ?? null, distance, flagged, flagReason, channel, reason ?? null]);

  const isCoverageChange = !!(defaultSite && site && defaultSite.id !== site.id);
  return { site, defaultSite, isCoverageChange, flagged, flagReason, distance, reason };
}

async function recordDpr({ supervisorId, siteId, content, contentType, channel }) {
  const { rows } = await pool.query(`
    INSERT INTO dpr_reports (supervisor_id, site_id, content, content_type, channel)
    VALUES ($1,$2,$3,$4,$5) RETURNING id
  `, [supervisorId, siteId ?? null, content, contentType, channel]);
  return { site: siteId ? await getSiteById(siteId) : null, dprId: rows[0].id };
}

async function saveVoiceAudio(dprId, buffer, mimeType = 'audio/ogg') {
  await pool.query(`INSERT INTO voice_audio (dpr_id, data, mime_type) VALUES ($1,$2,$3)`, [dprId, buffer, mimeType]);
}

async function getPendingVoiceDprs() {
  const { rows } = await pool.query(`
    SELECT d.id FROM dpr_reports d
    JOIN voice_audio v ON v.dpr_id = d.id
    WHERE d.content_type = 'voice' AND d.transcribed = FALSE
    ORDER BY d.created_at ASC
  `);
  return rows;
}

async function getVoiceAudio(dprId) {
  const { rows } = await pool.query(`SELECT data, mime_type FROM voice_audio WHERE dpr_id = $1`, [dprId]);
  return rows[0] || null;
}

async function markDprTranscribed(dprId, text) {
  await pool.query(`UPDATE dpr_reports SET content = $1, transcribed = TRUE WHERE id = $2`, [text, dprId]);
}

async function setPending(chatId, fields) {
  await pool.query(`
    INSERT INTO pending_actions (chat_id, action, site_id, dpr_text, awaiting_reason, reason, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6, now())
    ON CONFLICT (chat_id) DO UPDATE SET
      action = EXCLUDED.action, site_id = EXCLUDED.site_id, dpr_text = EXCLUDED.dpr_text,
      awaiting_reason = EXCLUDED.awaiting_reason, reason = EXCLUDED.reason, updated_at = now()
  `, [String(chatId), fields.action ?? null, fields.siteId ?? null, fields.dprText ?? null,
      fields.awaitingReason ?? false, fields.reason ?? null]);
}

async function getPending(chatId) {
  const { rows } = await pool.query(`SELECT * FROM pending_actions WHERE chat_id = $1`, [String(chatId)]);
  if (!rows[0]) return null;
  const r = rows[0];
  return { action: r.action, siteId: r.site_id, dprText: r.dpr_text, awaitingReason: r.awaiting_reason, reason: r.reason };
}

async function clearPending(chatId) {
  await pool.query(`DELETE FROM pending_actions WHERE chat_id = $1`, [String(chatId)]);
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// Which calendar day (IST) the digest should actually summarize. Normally
// that's "today" — but if this runs very early in the morning (GitHub's
// scheduler delayed it past midnight, as happened on Sept 23), "today"
// would technically have just started with zero activity, making the
// digest wrongly claim everyone missed their check-in. Before 6 AM IST,
// nobody's genuinely expected on site yet — so a digest firing that early
// almost certainly means it's a delayed run that should report on
// YESTERDAY instead. This makes the digest self-correcting against
// scheduler delays, rather than just hoping they don't happen.
function getDigestTargetDateIST() {
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  if (nowIST.getHours() < 6) nowIST.setDate(nowIST.getDate() - 1);
  const y = nowIST.getFullYear();
  const m = String(nowIST.getMonth() + 1).padStart(2, '0');
  const d = String(nowIST.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function buildDailyDigest() {
  const targetDate = getDigestTargetDateIST();
  const { rows: supervisors } = await pool.query(`SELECT * FROM supervisors WHERE active = TRUE ORDER BY name`);

  const headerDate = new Date(`${targetDate}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const lines = [`*RkICS — Daily Site Summary*`, headerDate, ''];

  let missedCount = 0, flagCount = 0, coverageCount = 0, otherCount = 0;

  for (const sup of supervisors) {
    const defaultSite = sup.default_site_id ? await getSiteById(sup.default_site_id) : null;

    const { rows: siteRows } = await pool.query(`
      SELECT DISTINCT site_id FROM (
        SELECT site_id FROM checkins WHERE supervisor_id = $1 AND site_id IS NOT NULL
          AND (created_at AT TIME ZONE '${TZ}')::date = $2::date
        UNION
        SELECT site_id FROM dpr_reports WHERE supervisor_id = $1 AND site_id IS NOT NULL
          AND (created_at AT TIME ZONE '${TZ}')::date = $2::date
      ) s
    `, [sup.id, targetDate]);

    const { rows: otherIn } = await pool.query(`
      SELECT * FROM checkins WHERE supervisor_id = $1 AND site_id IS NULL AND type = 'IN'
        AND (created_at AT TIME ZONE '${TZ}')::date = $2::date
      ORDER BY created_at ASC LIMIT 1
    `, [sup.id, targetDate]);
    const { rows: otherOut } = await pool.query(`
      SELECT * FROM checkins WHERE supervisor_id = $1 AND site_id IS NULL AND type = 'OUT'
        AND (created_at AT TIME ZONE '${TZ}')::date = $2::date
      ORDER BY created_at DESC LIMIT 1
    `, [sup.id, targetDate]);
    const hasOtherToday = otherIn[0] || otherOut[0];

    if (siteRows.length === 0 && !hasOtherToday) {
      missedCount++;
      lines.push(`*${sup.name}* — ${defaultSite ? defaultSite.name : 'no default site'} ⚠️ no check-in`, '');
      continue;
    }

    for (const { site_id } of siteRows) {
      const site = await getSiteById(site_id);
      const { rows: inRows } = await pool.query(`
        SELECT * FROM checkins WHERE supervisor_id=$1 AND site_id=$2 AND type='IN'
          AND (created_at AT TIME ZONE '${TZ}')::date = $3::date
        ORDER BY created_at ASC LIMIT 1
      `, [sup.id, site_id, targetDate]);
      const { rows: outRows } = await pool.query(`
        SELECT * FROM checkins WHERE supervisor_id=$1 AND site_id=$2 AND type='OUT'
          AND (created_at AT TIME ZONE '${TZ}')::date = $3::date
        ORDER BY created_at DESC LIMIT 1
      `, [sup.id, site_id, targetDate]);
      const { rows: dprRows } = await pool.query(`
        SELECT * FROM dpr_reports WHERE supervisor_id=$1 AND site_id=$2
          AND (created_at AT TIME ZONE '${TZ}')::date = $3::date
        ORDER BY created_at DESC LIMIT 1
      `, [sup.id, site_id, targetDate]);

      const fmtT = (d) => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
      const inRow = inRows[0], outRow = outRows[0], dpr = dprRows[0];

      let statusFlag = '';
      const isCoverage = defaultSite && site && defaultSite.id !== site.id;
      if (isCoverage) { coverageCount++; statusFlag += ` 🔁 covering (usual: ${defaultSite.name})`; }
      if ((inRow && inRow.flagged) || (outRow && outRow.flagged)) { flagCount++; statusFlag += ' ⚠️ location flagged'; }

      lines.push(
        `*${sup.name}* — ${site ? site.name : 'unknown site'}${statusFlag}`,
        `  In: ${fmtT(inRow?.created_at)}  Out: ${fmtT(outRow?.created_at)}`,
        `  DPR: ${dpr ? truncate(dpr.content, 90) : 'No DPR submitted'}`, ''
      );
    }

    if (hasOtherToday) {
      otherCount++;
      const reasonText = otherIn[0]?.reason || otherOut[0]?.reason || 'No reason given';
      const fmtT = (d) => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
      lines.push(
        `*${sup.name}* — 🛫 Out of Station / Other: ${truncate(reasonText, 80)}`,
        `  In: ${fmtT(otherIn[0]?.created_at)}  Out: ${fmtT(otherOut[0]?.created_at)}`, ''
      );
    }
  }

  lines.push(`Summary: ${supervisors.length} supervisors | ${missedCount} missed check-in | ${flagCount} location flags | ${coverageCount} site coverage changes | ${otherCount} out-of-station reports`);
  return lines.join('\n');
}

module.exports = {
  findSupervisorByChannelId, listActiveSites, getSiteById, getDefaultSite,
  getLatestTodaySiteForSupervisor, recordCheckin, recordDpr, saveVoiceAudio,
  getPendingVoiceDprs, getVoiceAudio, markDprTranscribed,
  setPending, getPending, clearPending, buildDailyDigest, getDigestTargetDateIST,
};
