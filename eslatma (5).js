// ============================================================================
//  ESLATMA moduli — hamma foydalanuvchiga eslatma yuboradi.
//    • har kuni soat 18:00 da (Toshkent vaqti) AVTOMATIK
//    • admin botga /eslatma deb yozsa — darhol hammaga
//    • admin /eslatma Bugun soat 20:00 da olimpiada! deb yozsa — o'sha matn hammaga
//  Hech qanday shart yo'q: faollik, oraliq, limit tekshirilmaydi — hammaga boradi.
//  Xabarda bitta tugma: "🚀 Ilovani ochish".
//
//  server.js ga BITTA qator qo'shiladi:
//      require('./eslatma')(app, { rtdb, BOT_TOKEN, loadDB, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY });
//
//  Admin buyruqlari (bot.py): /eslatma · /eslatma <matn> · /eslatma test (faqat sizga) · /eslatma off · /eslatma on
//  RTDB: settings/nudge/enabled (standart: yoqilgan), meta/nudge/lastRunDay
// ============================================================================
'use strict';

module.exports = function mountNudge(app, deps) {
  const { rtdb, BOT_TOKEN, loadDB, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY } = deps;
  const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const APP_URL = process.env.MINI_APP_URL || process.env.OLIMP_APP_URL || 'https://yusufalizufarov42-tech.github.io/atlas-mini-app/';
  const SEND_AT = 18 * 60;      // 18:00 Toshkent
  const WINDOW_MIN = 180;       // server uxlab qolgan bo'lsa, 18:00 dan keyin 3 soat ichida uyg'onganda ham yuboriladi

  // {ism} bo'lmasa, xabar ismsiz ham to'g'ri o'qiladi
  const VARIANTS = [
    'Hoy, {ism}! 😄 Qayerlarda yuribsiz? Kimyo sizni sog\'indi — bir-ikkita savol yechib ketamizmi?',
    '{ism}, keling endi, yura verasizmi? 😅 Bugun atigi 5 ta savol — 3 daqiqalik ish!',
    '⚛️ Atomlar sizni kutib qoldi! Qaytib keling, mashqni davom ettiramiz.',
    'Salom, {ism}! Imtihongacha vaqt o\'tib boryapti ⏳ Kuniga 10 ta savol ham katta natija beradi. Keling, boshlaymiz!',
    'Eh, {ism}... biz sizni kutdik-kutdik 🥲 Ilovaga bir kirib qo\'ying — yangi savollar ko\'paydi!',
    'Bugun kimyoga 5 daqiqa ajratsangiz bo\'ladi 😉 Savollar tayyor, faqat o\'zingiz yetishmayapsiz!',
    'Muntazam mashq qilganlar imtihonda ancha yaxshi natija ko\'rsatadi 💪 Bugun navbat sizda, {ism}!',
    'Hoy! 👋 Olimpiadalar va yangi bo\'limlar sizni kutyapti. Bir ko\'rib o\'tmaysizmi?',
    '{ism}, zerikib qoldingizmi? 😄 Keling, bir-ikki masala yechib ko\'ramiz!',
    'Mashq qilmagan kun — o\'qilmagan kun 📚 Qani, ilovaga!',
    'Assalomu alaykum, {ism}! Atlas Ilm sizni sog\'indi 🌟 Qaytib kelsangiz, mazza qilamiz!',
    'Yana ko\'rinmay ketdingiz-ku 🙈 Kelinglar, bir savol bilan qaytamiz!'
  ];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = async p => (await rtdb.ref(p).once('value')).val();
  const tashkentDay = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(t));
  const tashkentMinutes = (t = Date.now()) => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)).split(':').map(Number); return (h % 24) * 60 + m; };
  const dayIndex = t => Math.floor((t + 5 * 3600000) / 86400000);   // Toshkent kuni raqami — har kuni boshqa matn

  // Standart matn: kunlik navbat bilan (hamma bir kunda bir xil matn oladi), ism bo'lsa — ism bilan
  function standardText(entry, now) {
    const name = String((entry && entry.telegramFirstName) || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    const t = VARIANTS[dayIndex(now) % VARIANTS.length];
    if (name) return t.replace(/\{ism\}/g, name);
    // ism yo'q: "Salom, {ism}!" -> "Salom!",  "{ism}, keling" -> "Keling"
    return t.replace(/,\s*\{ism\}/g, '').replace(/\{ism\},\s*/g, '').replace(/\{ism\}\s*/g, '').replace(/^\s*(\S)/, (m, c) => c.toUpperCase());
  }

  async function tgSend(uid, text) {
    const body = { chat_id: uid, text, reply_markup: { inline_keyboard: [[{ text: '🚀 Ilovani ochish', web_app: { url: APP_URL } }]] } };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.ok) return { ok: true };
        if (j.error_code === 429 && j.parameters && j.parameters.retry_after) { await sleep(Math.min(j.parameters.retry_after, 15) * 1000 + 200); continue; }
        return { ok: false, blocked: j.error_code === 403 || j.error_code === 400, desc: String(j.description || '').slice(0, 160) };
      } catch (e) { /* tarmoq xatosi — qayta urinamiz */ }
    }
    return { ok: false, desc: 'tarmoq xatosi' };
  }

  // Hammaga yuborish. customText bo'lsa — aynan o'sha matn, bo'lmasa — standart eslatma.
  async function sendAll(customText, now, reportTo) {
    now = now || Date.now();
    const db = (await loadDB()) || {};
    const ids = Object.keys(db).filter(k => /^\d+$/.test(k));
    let sent = 0, blocked = 0;
    for (const uid of ids) {
      const r = await tgSend(uid, customText || standardText(db[uid], now));
      if (r.ok) sent++; else blocked++;
      await sleep(40);                                                    // Telegram tezlik chegarasi (~30 xabar/soniya)
    }
    const admins = reportTo ? [String(reportTo)] : ids.filter(k => db[k] && db[k].isAdmin);
    for (const a of admins) await tgSend(a, `✅ Eslatma yuborildi\n📬 Yetkazildi: ${sent}\n🚫 Yetmadi (botni bloklagan yoki start bosmagan): ${blocked}\n👥 Jami: ${ids.length}`);
    return { sent, blocked, total: ids.length };
  }

  let running = false;
  async function tick(now) {
    now = typeof now === 'number' ? now : Date.now();
    if (running) return; running = true;
    try {
      if ((await get('settings/nudge/enabled')) === false) return;
      const cur = tashkentMinutes(now);
      if (cur < SEND_AT || cur >= SEND_AT + WINDOW_MIN) return;           // hali 18:00 emas yoki o'tib ketgan
      const today = tashkentDay(now);
      const tx = await rtdb.ref('meta/nudge/lastRunDay').transaction(c => (c === today ? undefined : today));
      if (!tx.committed) return;                                          // bugun allaqachon yuborilgan
      const r = await sendAll(null, now);
      console.log(`[eslatma] ${today}: yetkazildi ${r.sent}/${r.total}`);
    } catch (e) { console.error('[eslatma] tick', e && e.message); } finally { running = false; }
  }
  if (rtdb) { const t = setInterval(() => tick(), 60 * 1000); if (t.unref) t.unref(); }

  // Admin (faqat botdan, INTERNAL_API_KEY bilan): send / test / on / off
  app.post('/api/admin/nudge', async (req, res) => {
    if (!INTERNAL_API_KEY) return res.status(503).json({ success: false, error: 'INTERNAL_API_KEY sozlanmagan' });
    if (!checkInternalKey(req, res)) return;
    const { adminUserId, action } = req.body || {};
    const text = String((req.body || {}).text || '').trim();
    if (!(await isAuthorizedAdmin({ adminUserId: String(adminUserId || '') }))) return res.status(403).json({ success: false, error: 'Admin huquqi tasdiqlanmadi' });
    if (action === 'on' || action === 'off') {
      await rtdb.ref('settings/nudge/enabled').set(action === 'on');
      return res.json({ success: true, enabled: action === 'on' });
    }
    if (action === 'test') {
      const db = await loadDB();
      const r = await tgSend(String(adminUserId), standardText(db[adminUserId] || {}, Date.now()));
      return res.json({ success: r.ok, error: r.ok ? undefined : 'Telegram xabarni qabul qilmadi: ' + (r.desc || 'noma\'lum sabab') });
    }
    if (action === 'send') {
      if (text.length > 1000) return res.status(400).json({ success: false, error: 'Matn 1000 belgidan oshmasin' });
      if (running) return res.status(409).json({ success: false, error: 'Eslatma yuborish hozir ketyapti, biroz kuting' });
      const db = (await loadDB()) || {};
      const total = Object.keys(db).filter(k => /^\d+$/.test(k)).length;
      running = true;
      res.json({ success: true, total });
      if (!text) await rtdb.ref('meta/nudge/lastRunDay').set(tashkentDay()).catch(() => {});   // bugun qo'lda yuborildi — 18:00 da takror ketmasin
      sendAll(text || null, Date.now(), adminUserId).catch(e => console.error('[eslatma] send', e && e.message)).finally(() => { running = false; });
      return;
    }
    res.status(400).json({ success: false, error: 'Noma\'lum amal' });
  });

  module.exports.__internal = { sendAll, tick, standardText, VARIANTS, tashkentMinutes };
};
