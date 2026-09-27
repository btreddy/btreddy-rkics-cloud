const core = require('../lib/core');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function tgSend(chatId, text, extra = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram API returned ok:false');
  return data;
}

module.exports = async (req, res) => {
  const text = await core.buildDailyDigest();
  const raw = process.env.TELEGRAM_DIGEST_CHAT_IDS || '';
  const chatIds = raw.split(',').map(s => s.trim()).filter(Boolean);

  const results = [];
  for (const id of chatIds) {
    try {
      await tgSend(id, text, { parse_mode: 'Markdown' });
      results.push({ chatId: id, ok: true });
    } catch (err) {
      results.push({ chatId: id, ok: false, error: err.message });
    }
  }

  const sent = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);

  res.status(200).json({
    configuredChatIds: chatIds.length,
    sent,
    failed: failed.length,
    failedDetails: failed, // shows exactly WHY each one failed, e.g. "chat not found"
    preview: text,
  });
};
