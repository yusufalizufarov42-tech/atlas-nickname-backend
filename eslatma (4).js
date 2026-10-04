// ============================================================================
//  ESLATMA moduli — ora-sira faol bo'lmagan foydalanuvchilarga do'stona "qaytib keling" xabari.
//  server.js ga BITTA qator qo'shiladi (olimpiada ulangan joyning yonida):
//      require('./eslatma')(app, { rtdb, BOT_TOKEN, loadDB, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY });
//
//  Qoidalar (spam bo'lib ketmasligi uchun):
//    • kuniga bir marta, admin belgilagan vaqtda (Toshkent vaqti bilan; standart 18:00, /eslatmalar vaqt 20:30 bilan o'zgartiriladi)
//    • faqat inactiveDays (2) kundan beri ilovaga kirmaganlarga
//    • bitta odamga kamida everyDays (3) kunda bir marta
//    • javob bermasa, ketma-ket maxStreak (4) martadan keyin to'xtaydi — qaytib kirsa, qayta boshlanadi
//    • bir kunda ko'pi bilan dailyCap (300) ta xabar (birinchi ishga tushishda hamma bir yo'la xabar olmasin)
//    • foydalanuvchi eslatmani o'chira olmaydi (faqat admin /eslatmalar off bilan hammasini to'xtata oladi)
//    • botni bloklagan / start bosmagan odamga 30 kun urinilmaydi
//
//  RTDB: users/{id}/lastSeenAt, users/{id}/nudge {lastAt, streak, blockedAt}
//        settings/nudge {enabled, time, inactiveDays, everyDays, maxStreak, dailyCap}
//        meta/nudge/lastRunDay, meta/nudge/stats/{kun}
// ============================================================================
'use strict';

module.exports = function mountNudge(app, deps) {
  const { rtdb, BOT_TOKEN, loadDB, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY } = deps;
  const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const APP_URL = process.env.MINI_APP_URL || process.env.OLIMP_APP_URL || 'https://yusufalizufarov42-tech.github.io/atlas-mini-app/';
  const DAY = 86400000;
  const DEFAULTS = { enabled: true, time: '18:00', inactiveDays: 2, everyDays: 3, maxStreak: 4, dailyCap: 300 };
  const WINDOW_MIN = 180;   // belgilangan vaqtdan keyin 3 soat ichida server uyg'ongan bo'lsa ham yuboriladi; undan keyin o'sha kunga o'tkazib yuboriladi

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
  const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  function textFor(uid, entry, streak) {
    const name = String(entry.telegramFirstName || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    const t = VARIANTS[(hash(uid) + streak) % VARIANTS.length];
    if (name) return t.replace(/\{ism\}/g, name);
    // ism yo'q: "Salom, {ism}!" -> "Salom!",  "{ism}, keling" -> "Keling"
    return t.replace(/,\s*\{ism\}/g, '').replace(/\{ism\},\s*/g, '').replace(/\{ism\}\s*/g, '').replace(/^\s*(\S)/, (m, c) => c.toUpperCase());
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = async p => (await rtdb.ref(p).once('value')).val();
  const tashkentDay = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(t));
  const tashkentMinutes = (t = Date.now()) => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)).split(':').map(Number); return (h % 24) * 60 + m; };
  const toMin = t => { const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(t || '').trim()); if (!m) return null; const h = +m[1], mi = +m[2]; return h < 24 && mi < 60 ? h * 60 + mi : null; };
  const fmtTime = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
  const settings = async () => {
    const st = (await get('settings/nudge')) || {};
    const S = Object.assign({}, DEFAULTS, st);
    if (!st.time && st.hour != null) S.time = fmtTime(Number(st.hour) * 60);        // eski sozlama (soat) bilan moslik
    if (toMin(S.time) === null) S.time = DEFAULTS.time;
    return S;
  };
  const lastActive = e => Math.max(Date.parse(e.lastSeenAt || '') || 0, Date.parse(e.updatedAt || '') || 0);

  async function tgSend(uid, text) {
    const body = { chat_id: uid, text, reply_markup: { inline_keyboard: [
      [{ text: '🚀 Ilovani ochish', web_app: { url: APP_URL } }]] } };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.ok) return { ok: true };
        if (j.error_code === 429 && j.parameters && j.parameters.retry_after) { await sleep(Math.min(j.parameters.retry_after, 15) * 1000 + 200); continue; }
        return { ok: false, blocked: j.error_code === 403 || j.error_code === 400, desc: String(j.description || '').slice(0, 160) };
      } catch (e) { /* tarmoq xatosi — qayta urinamiz */ }
    }
    return { ok: false, blocked: false };
  }

  // Kimga yuboriladi? (cap qo'llanmasdan)
  function eligible(db, S, now, all) {
    const out = [];
    for (const uid of Object.keys(db)) {
      if (!/^\d+$/.test(uid)) continue;
      const e = db[uid] || {}, n = e.nudge || {};
      if (n.blockedAt && now - n.blockedAt < 30 * DAY) continue;
      const act = lastActive(e);
      const streak = n.lastAt && n.lastAt > act ? (n.streak || 0) : 0;   // faollik bo'lsa, hisob qaytadan boshlanadi
      if (!all) {                                                         // "hamma" rejimida (admin qo'lda) faollik/oraliq/streak hisobga olinmaydi
        if (!act || now - act < S.inactiveDays * DAY) continue;           // yaqinda faol yoki ma'lumot yo'q
        if (n.lastAt && now - n.lastAt < S.everyDays * DAY) continue;
        if (streak >= S.maxStreak) continue;
      }
      out.push({ uid, e, act, streak });
    }
    out.sort((a, b) => b.act - a.act);                                   // yaqinda faol bo'lganlar qaytishga ko'proq moyil
    return out;
  }

  async function run(now, everyone) {
    now = now || Date.now();
    const S = await settings();
    const db = (await loadDB()) || {};
    const all = eligible(db, S, now, everyone), batch = everyone ? all : all.slice(0, S.dailyCap);
    let sent = 0, blocked = 0;
    for (const { uid, e, streak } of batch) {
      const r = await tgSend(uid, textFor(uid, e, streak));
      if (r.ok) { sent++; await rtdb.ref(`users/${uid}/nudge`).update({ lastAt: now, streak: streak + 1 }); }
      else if (r.blocked) { blocked++; await rtdb.ref(`users/${uid}/nudge`).update({ blockedAt: now }); }
      await sleep(40);
    }
    await rtdb.ref(`meta/nudge/stats/${tashkentDay(now)}`).set({ sent, blocked, eligible: all.length, at: now });
    return { sent, blocked, eligible: all.length };
  }

  let running = false;
  async function tick(now) {
    now = typeof now === 'number' ? now : Date.now();
    if (running) return; running = true;
    try {
      const S = await settings();
      if (!S.enabled) return;
      const target = toMin(S.time), cur = tashkentMinutes(now);
      if (cur < target || cur >= target + WINDOW_MIN) return;            // hali vaqti kelmagan yoki o'tib ketgan
      const today = tashkentDay(now);
      const tx = await rtdb.ref('meta/nudge/lastRunDay').transaction(c => (c === today ? undefined : today));
      if (!tx.committed) return;                                         // bugun allaqachon ishlagan
      const r = await run(now);
      console.log(`[eslatma] ${today}: yuborildi ${r.sent}, bloklangan ${r.blocked}, mos edi ${r.eligible}`);
    } catch (e) { console.error('[eslatma] tick', e && e.message); } finally { running = false; }
  }
  if (rtdb) { const t = setInterval(() => tick(), 60 * 1000); if (t.unref) t.unref(); }

  /* ---------- endpointlar ---------- */
  // Admin: holat / yoqish / o'chirish / sinov
  app.post('/api/admin/nudge', async (req, res) => {
    if (!INTERNAL_API_KEY) return res.status(503).json({ success: false, error: 'INTERNAL_API_KEY sozlanmagan' });
    if (!checkInternalKey(req, res)) return;
    const { adminUserId, action } = req.body || {};
    if (!(await isAuthorizedAdmin({ adminUserId: String(adminUserId || '') }))) return res.status(403).json({ success: false, error: 'Admin huquqi tasdiqlanmadi' });
    const S = await settings();
    if (action === 'on' || action === 'off') {
      await rtdb.ref('settings/nudge/enabled').set(action === 'on');
      return res.json({ success: true, enabled: action === 'on' });
    }
    if (action === 'time') {                                               // kunlik yuborish vaqtini belgilash (Toshkent vaqti)
      const min = toMin((req.body || {}).time);
      if (min === null) return res.status(400).json({ success: false, error: 'Vaqt noto\'g\'ri. Masalan: 20:30' });
      await rtdb.ref('settings/nudge/time').set(fmtTime(min));
      await rtdb.ref('settings/nudge/hour').remove();
      return res.json({ success: true, time: fmtTime(min) });
    }
    if (action === 'run') {                                               // "hozir yubor" — kutmasdan, bugungi navbatdan tashqari
      if (running) return res.status(409).json({ success: false, error: 'Eslatma yuborish hozir ketyapti, biroz kuting' });
      const everyone = !!(req.body || {}).all;
      const dbNow = (await loadDB()) || {}, n = eligible(dbNow, S, Date.now(), everyone).length;
      if (!n) return res.json({ success: true, eligible: 0, willSend: 0 });
      running = true;
      res.json({ success: true, eligible: n, willSend: everyone ? n : Math.min(n, S.dailyCap), all: everyone });
      run(Date.now(), everyone).then(async r => {
        await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: String(adminUserId), text: `✅ Eslatma yuborildi\n📬 Yetkazildi: ${r.sent}\n🚫 Botni bloklagan / start bosmagan: ${r.blocked}\n🎯 Mos edi: ${r.eligible}` }) }).catch(() => {});
      }).catch(e => console.error('[eslatma] run', e && e.message)).finally(() => { running = false; });
      return;
    }
    if (action === 'test') {
      const db = await loadDB();
      const r = await tgSend(String(adminUserId), textFor(String(adminUserId), db[adminUserId] || {}, 0));
      return res.json({ success: r.ok, error: r.ok ? undefined : 'Telegram xabarni qabul qilmadi: ' + (r.desc || 'noma\'lum sabab') });
    }
    const db = (await loadDB()) || {}, now = Date.now();
    const ids = Object.keys(db).filter(k => /^\d+$/.test(k));
    const stats = await get(`meta/nudge/stats/${tashkentDay()}`);
    res.json({ success: true, enabled: S.enabled, settings: S, total: ids.length,
      blocked: ids.filter(k => db[k].nudge && db[k].nudge.blockedAt && now - db[k].nudge.blockedAt < 30 * DAY).length,
      eligibleNow: eligible(db, S, now).length, lastRunDay: (await get('meta/nudge/lastRunDay')) || null, today: stats || null });
  });

  module.exports.__internal = { run, tick, eligible, textFor, settings, VARIANTS, DEFAULTS, toMin, tashkentMinutes };
};
