const core = require('../lib/core');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function tgSend(chatId, text, extra = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  return res.json();
}

module.exports = async (req, res) => {
  // Vercel Cron calls this automatically at the scheduled time (see
  // vercel.json). Also safe to hit manually to send an on-demand digest.
  const text = await core.buildDailyDigest();
  const chatIds = (process.env.TELEGRAM_DIGEST_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  for (const id of chatIds) {
    try {
      await tgSend(id, text, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`digest send failed for ${id}:`, err.message);
    }
  }

  res.status(200).json({ sent: chatIds.length, preview: text });
};
