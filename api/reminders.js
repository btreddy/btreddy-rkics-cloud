const { getMissingCheckins, getEveningGaps } = require('../lib/reminders');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function tgSend(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return res.json();
}

module.exports = async (req, res) => {
  const type = req.query.type; // 'morning' | 'evening'
  let sent = 0;
  const details = [];

  if (type === 'morning') {
    const missing = await getMissingCheckins();
    for (const sup of missing) {
      await tgSend(sup.telegram_chat_id,
        `Good morning! 👋 Looks like you haven't checked in yet today. Please send /in when you reach site — thanks!`
      ).catch(() => {});
      sent++;
      details.push(sup.name);
    }
  } else if (type === 'evening') {
    const gaps = await getEveningGaps();
    for (const sup of gaps) {
      const lines = [`Hi ${sup.name}, just a friendly reminder before the day wraps up:`];
      if (sup.missingCheckout) lines.push(`• You haven't checked out yet — please send /out when you're done.`);
      if (sup.missingDpr) lines.push(`• Today's DPR hasn't been submitted yet — /dpr or a voice note works.`);
      lines.push(`Thanks! 🙏`);
      await tgSend(sup.telegram_chat_id, lines.join('\n')).catch(() => {});
      sent++;
      details.push(sup.name);
    }
  } else {
    return res.status(400).json({ error: 'Missing or invalid ?type= (use "morning" or "evening")' });
  }

  res.status(200).json({ type, sent, supervisors: details });
};
