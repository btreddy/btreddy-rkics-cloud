const core = require('../lib/core');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

async function tgCall(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

const tgSend = (chatId, text, extra = {}) => tgCall('sendMessage', { chat_id: chatId, text, ...extra });
const tgAnswerCallback = (id, opts = {}) => tgCall('answerCallbackQuery', { callback_query_id: id, ...opts });

async function tgDownloadFile(fileId) {
  const info = await tgCall('getFile', { file_id: fileId });
  const filePath = info.result.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`);
  return Buffer.from(await res.arrayBuffer());
}

function digestChatIds() {
  return (process.env.TELEGRAM_DIGEST_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function siteKeyboard(prefix) {
  const sites = await core.listActiveSites();
  if (sites.length === 0) return null;
  const rows = sites.map(s => [{ text: s.name, callback_data: `${prefix}:${s.id}` }]);
  rows.push([{ text: '📍 Other / Out of Station', callback_data: `${prefix}:OTHER` }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function notRegisteredMsg(chatId) {
  return `You're not registered yet. Ask your admin to add you with this chat ID: ${chatId}`;
}

async function processUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message;
  if (!msg) return;

  if (msg.text?.startsWith('/start')) return handleStart(msg);
  if (msg.text?.startsWith('/in')) return handleInOut(msg, 'IN');
  if (msg.text?.startsWith('/out')) return handleInOut(msg, 'OUT');
  if (msg.text?.startsWith('/dpr')) return handleDprCommand(msg);
  if (msg.location) return handleLocation(msg);
  if (msg.voice) return handleVoice(msg);
  if (msg.text) return handlePlainText(msg);
}

async function handleStart(msg) {
  await tgSend(msg.chat.id,
    `Welcome to the RkICS Site Tracker.\n\n` +
    `Commands:\n` +
    `• /in — mark arrival (pick site, then share location)\n` +
    `• /out — mark departure (pick site, then share location)\n` +
    `• /dpr — submit today's DPR (text or voice note)\n\n` +
    `Going somewhere not on the list? Pick "Other / Out of Station" and type the reason.\n\n` +
    `If you're not registered yet, ask your admin to add this chat ID: ${msg.chat.id}`);
}

async function handleInOut(msg, action) {
  const sup = await core.findSupervisorByChannelId('telegram', msg.chat.id);
  if (!sup) return tgSend(msg.chat.id, notRegisteredMsg(msg.chat.id));
  const kb = await siteKeyboard(action);
  if (!kb) return tgSend(msg.chat.id, 'No sites set up yet — ask your admin to add one.');
  await tgSend(msg.chat.id, action === 'IN' ? 'Which site are you at?' : 'Leaving which site?', kb);
}

async function handleDprCommand(msg) {
  const sup = await core.findSupervisorByChannelId('telegram', msg.chat.id);
  if (!sup) return tgSend(msg.chat.id, notRegisteredMsg(msg.chat.id));
  const content = msg.text.replace(/^\/dpr\s*/i, '').trim();

  if (content) {
    const site = await core.getLatestTodaySiteForSupervisor(sup.id);
    if (site) {
      await core.recordDpr({ supervisorId: sup.id, siteId: site.id, content, contentType: 'text', channel: 'telegram' });
      return tgSend(msg.chat.id, `✅ DPR logged for ${site.name}. Thanks!`);
    }
    await core.setPending(msg.chat.id, { action: 'DPR', dprText: content });
    const kb = await siteKeyboard('DPRSITE');
    if (!kb) return tgSend(msg.chat.id, 'No sites set up yet — ask your admin to add one.');
    return tgSend(msg.chat.id, 'Which site is this DPR for?', kb);
  }
  return tgSend(msg.chat.id, 'Send it like: /dpr Poured slab on block C, 3 masons on site.\n\nOr just send a voice note instead.');
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const [prefix, siteIdStr] = query.data.split(':');

  if (siteIdStr === 'OTHER' && (prefix === 'IN' || prefix === 'OUT')) {
    await core.setPending(chatId, { action: prefix, siteId: null, awaitingReason: true });
    await tgAnswerCallback(query.id);
    return tgSend(chatId, `📝 Please type the reason (e.g. "Out of station — Vijayawada site visit").`);
  }

  const siteId = parseInt(siteIdStr, 10);
  const site = await core.getSiteById(siteId);
  if (!site) return tgAnswerCallback(query.id, { text: 'Site not found' });

  if (prefix === 'IN' || prefix === 'OUT') {
    await core.setPending(chatId, { action: prefix, siteId });
    await tgAnswerCallback(query.id);
    return tgSend(chatId, `📍 Share your location now to confirm ${prefix} at ${site.name}.`);
  }

  if (prefix === 'DPRSITE') {
    const p = await core.getPending(chatId);
    const sup = await core.findSupervisorByChannelId('telegram', chatId);
    if (sup && p?.dprText) {
      await core.recordDpr({ supervisorId: sup.id, siteId, content: p.dprText, contentType: 'text', channel: 'telegram' });
      await core.clearPending(chatId);
      await tgAnswerCallback(query.id);
      return tgSend(chatId, `✅ DPR logged for ${site.name}. Thanks!`);
    }
  }
}

async function handlePlainText(msg) {
  const chatId = msg.chat.id;
  const p = await core.getPending(chatId);
  if (p && p.awaitingReason) {
    await core.setPending(chatId, { ...p, reason: msg.text.trim(), awaitingReason: false });
    return tgSend(chatId, `📍 Got it. Now share your location to confirm ${p.action}.`);
  }
  const sup = await core.findSupervisorByChannelId('telegram', chatId);
  if (!sup) return tgSend(chatId, notRegisteredMsg(chatId));
  await tgSend(chatId,
    `I didn't quite catch that. To submit a DPR, type it starting with /dpr, like:\n` +
    `/dpr Poured slab on block C, 3 masons on site.\n\n` +
    `Or use /in, /out, or send a voice note directly.`);
}

async function handleLocation(msg) {
  const chatId = msg.chat.id;
  const sup = await core.findSupervisorByChannelId('telegram', chatId);
  if (!sup) return tgSend(chatId, notRegisteredMsg(chatId));

  const p = await core.getPending(chatId);
  if (!p || (p.action !== 'IN' && p.action !== 'OUT')) {
    return tgSend(chatId, 'Got your location — but tell me first: /in or /out?');
  }
  if (p.awaitingReason) {
    return tgSend(chatId, 'One more thing first — please type the reason for "Other / Out of Station", then share location again.');
  }
  await core.clearPending(chatId);

  const { latitude, longitude } = msg.location;
  const result = await core.recordCheckin({
    supervisorId: sup.id, siteId: p.siteId, type: p.action,
    latitude, longitude, channel: 'telegram', reason: p.reason || null,
  });

  const time = new Date(msg.date * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const siteName = result.site ? result.site.name : (p.reason ? `Other — ${p.reason}` : 'unassigned');
  let reply = `✅ Logged: ${p.action} at ${time} — ${siteName}`;
  if (result.flagged) reply += `\n⚠️ Note: ${result.flagReason}. This has been noted.`;
  if (result.isCoverageChange) reply += `\n🔁 Noted you're covering ${siteName} today (usual: ${result.defaultSite.name}) — MD/CEO have been informed.`;
  await tgSend(chatId, reply);

  if (result.isCoverageChange && p.action === 'IN') {
    const alertText = `🔁 *Site coverage change*\n${sup.name} checked IN at *${siteName}* today instead of their usual site (${result.defaultSite.name}) — ${time}.`;
    for (const id of digestChatIds()) {
      await tgSend(id, alertText, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }
}

async function handleVoice(msg) {
  const chatId = msg.chat.id;
  const sup = await core.findSupervisorByChannelId('telegram', chatId);
  if (!sup) return tgSend(chatId, notRegisteredMsg(chatId));

  const site = await core.getLatestTodaySiteForSupervisor(sup.id);
  const { dprId } = await core.recordDpr({
    supervisorId: sup.id, siteId: site ? site.id : null,
    content: '[voice note received — pending transcription]', contentType: 'voice', channel: 'telegram',
  });

  try {
    const buffer = await tgDownloadFile(msg.voice.file_id);
    await core.saveVoiceAudio(dprId, buffer, msg.voice.mime_type || 'audio/ogg');
  } catch (err) {
    console.error('voice download/save failed:', err.message);
  }

  await tgSend(chatId, `✅ Voice DPR received${site ? ` for ${site.name}` : ''} and logged for today. Thanks!`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('RkICS Telegram webhook is live.');
  try {
    await processUpdate(req.body);
  } catch (err) {
    console.error('webhook error:', err);
  }
  res.status(200).send('ok');
};

module.exports.processUpdate = processUpdate;
