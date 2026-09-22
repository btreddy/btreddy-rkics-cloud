const pool = require('./db');
const TZ = 'Asia/Kolkata';

// Anyone active with a Telegram ID who hasn't checked IN at all today —
// counts "Other / Out of Station" as checked in too, since that's still a
// valid report of where they are, just not a fixed site.
async function getMissingCheckins() {
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.telegram_chat_id
    FROM supervisors s
    WHERE s.active = TRUE AND s.telegram_chat_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM checkins c
        WHERE c.supervisor_id = s.id AND c.type = 'IN'
          AND (c.created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
      )
  `);
  return rows;
}

// Anyone who checked IN today but hasn't checked OUT, and/or hasn't sent a
// DPR today. Only includes people who actually checked in (no point
// nudging someone about checkout who never started their day — that's
// the morning reminder's job).
async function getEveningGaps() {
  const { rows } = await pool.query(`
    SELECT s.id, s.name, s.telegram_chat_id,
      EXISTS (
        SELECT 1 FROM checkins c WHERE c.supervisor_id = s.id AND c.type = 'IN'
          AND (c.created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
      ) AS checked_in_today,
      EXISTS (
        SELECT 1 FROM checkins c WHERE c.supervisor_id = s.id AND c.type = 'OUT'
          AND (c.created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
      ) AS checked_out_today,
      EXISTS (
        SELECT 1 FROM dpr_reports d WHERE d.supervisor_id = s.id
          AND (d.created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
      ) AS sent_dpr_today
    FROM supervisors s
    WHERE s.active = TRUE AND s.telegram_chat_id IS NOT NULL
  `);

  return rows
    .filter(r => r.checked_in_today && (!r.checked_out_today || !r.sent_dpr_today))
    .map(r => ({
      id: r.id, name: r.name, telegram_chat_id: r.telegram_chat_id,
      missingCheckout: !r.checked_out_today,
      missingDpr: !r.sent_dpr_today,
    }));
}

module.exports = { getMissingCheckins, getEveningGaps };
