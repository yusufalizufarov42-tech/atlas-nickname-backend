// ============================================================================
//  KUNLIK moduli
//   1) Kunlik viktorina: har kuni 10:00 (Toshkent) bankdan 8 ta savol Telegram quiz ko'rinishida
//      hamma foydalanuvchilarga va kanalga boradi; 9-xabar: "nechtasini topdingiz?" so'rovnomasi.
//   2) Haftalik shaxsiy hisobot: yakshanba 20:00 (Toshkent).
//   3) Taklif reytingi: GET /api/referral-top
//
//  server.js ga (viktorina.js dan OLDIN) BITTA qator qo'shiladi:
//      require('./kunlik')(app, { rtdb, BOT_TOKEN, loadDB, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY });
//  Fayllar: bank.json (savollar), topics.json (mavzu nomlari). Kanal: DAILY_CHANNEL (standart @atlas_ilm).
//  Admin (bot orqali): /api/admin/daily  { action: send | test | on | off | weekly | weeklytest }
//  RTDB: settings/daily/enabled, meta/daily/{lastRunDay,used}, meta/weekly/lastRunMon, users/{id}/week {m,t,c}
// ============================================================================
'use strict';

module.exports = function mountDaily(app, deps) {
  const { rtdb, BOT_TOKEN, loadDB, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY } = deps;
  const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const APP_URL = process.env.MINI_APP_URL || 'https://yusufalizufarov42-tech.github.io/atlas-mini-app/';
  const CHANNEL = process.env.DAILY_CHANNEL || '@atlas_ilm';
  const DAILY_AT = 10 * 60, WEEKLY_AT = 20 * 60, WINDOW_MIN = 180, N = 8;
  let bank = [], topics = {};
  try { bank = require('./bank.json'); } catch (e) { console.error('[kunlik] bank.json topilmadi'); }
  try { topics = require('./topics.json'); } catch (e) { /* mavzu nomlari ixtiyoriy */ }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = async p => (await rtdb.ref(p).once('value')).val();
  const tashkentDay = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(t));
  const tashkentMinutes = (t = Date.now()) => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)).split(':').map(Number); return (h % 24) * 60 + m; };
  const isSunday = (t = Date.now()) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tashkent', weekday: 'short' }).format(new Date(t)) === 'Sun';
  function mondayOf(t = Date.now()) {            // joriy haftaning dushanbasi (Toshkent), "YYYY-MM-DD"
    const d = new Date(tashkentDay(t) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  // Haftalik faollik hisoblagichi (server.js va viktorina.js chaqiradi)
  app.locals.bumpWeek = async (uid, correct, total) => {
    try {
      const m = mondayOf();
      await rtdb.ref(`users/${uid}/week`).transaction(c => { if (!c || c.m !== m) c = { m, t: 0, c: 0 }; c.t += total; c.c += correct; return c; });
    } catch (e) { /* hisoblagich xatosi asosiy ishga xalaqit bermasin */ }
  };

  async function tg(method, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.ok) return { ok: true, result: j.result };
        if (j.error_code === 429 && j.parameters && j.parameters.retry_after) { await sleep(Math.min(j.parameters.retry_after, 15) * 1000 + 200); continue; }
        return { ok: false, blocked: j.error_code === 403 };
      } catch (e) { /* tarmoq xatosi — qayta urinamiz */ }
    }
    return { ok: false };
  }
  const say = (chat_id, text, withApp) => tg('sendMessage', { chat_id, text, ...(withApp ? { reply_markup: { inline_keyboard: [[{ text: '🚀 Ilovani ochish', web_app: { url: APP_URL } }]] } } : {}) });
  const userIds = db => Object.keys(db).filter(k => /^\d+$/.test(k));

  // ---------------------------------------------------------------- KUNLIK VIKTORINA
  async function sendDaily(onlyTo) {
    if (!bank.length) throw new Error('bank.json bo\'sh');
    const used = new Set((await get('meta/daily/used')) || []);
    let pool = bank.map((_, i) => i).filter(i => !used.has(i));
    if (pool.length < N) { used.clear(); pool = bank.map((_, i) => i); }          // savollar tugasa — qaytadan boshlanadi
    const picked = shuffle(pool).slice(0, N);
    if (!onlyTo) await rtdb.ref('meta/daily/used').set([...used, ...picked]);
    const stamp = Date.now().toString(36);
    const quiz = picked.map((bi, k) => ({ id: `d${stamp}${k}`, q: bank[bi].q, o: bank[bi].o, a: bank[bi].a }));
    const db = (await loadDB()) || {};
    const ids = onlyTo ? [String(onlyTo)] : userIds(db);
    for (const z of quiz) await rtdb.ref(`quiz/${z.id}`).set({ id: z.id, daily: true, question: z.q, options: z.o, correct: z.a, explanation: '', createdAt: Date.now(), total: ids.length, sent: 0, blocked: 0, status: 'sending' });

    const countPoll = { question: `Bugungi ${N} ta savoldan nechtasini topdingiz?`, options: Array.from({ length: N + 1 }, (_, i) => ({ text: `${i} ta` })), type: 'regular' };
    let reached = 0, blocked = 0;
    for (const uid of ids) {
      let first = true;
      for (const z of quiz) {
        const r = await tg('sendPoll', { chat_id: uid, question: z.q, options: z.o.map(text => ({ text })), type: 'quiz', correct_option_id: z.a, is_anonymous: false });
        if (r.ok && r.result && r.result.poll) { await rtdb.ref(`quiz_poll/${r.result.poll.id}`).set(`${z.id}:${uid}`); if (first) { reached++; first = false; } }
        else { if (r.blocked) blocked++; break; }                                   // bloklagan — qolganini yubormaymiz
        await sleep(35);
      }
      if (!first) await tg('sendPoll', { chat_id: uid, ...countPoll, is_anonymous: true });
      await sleep(40);
    }
    if (!onlyTo) {                                                                  // kanalga (anonim quiz)
      for (const z of quiz) { await tg('sendPoll', { chat_id: CHANNEL, question: z.q, options: z.o.map(text => ({ text })), type: 'quiz', correct_option_id: z.a, is_anonymous: true }); await sleep(1200); }
      await tg('sendPoll', { chat_id: CHANNEL, ...countPoll, is_anonymous: true });
    }
    for (const z of quiz) await rtdb.ref(`quiz/${z.id}`).update({ sent: reached, blocked, status: 'done' });
    const admins = onlyTo ? [String(onlyTo)] : ids.filter(k => db[k] && db[k].isAdmin);
    for (const a of admins) await say(a, `✅ Kunlik viktorina${onlyTo ? ' (sinov)' : ''} yuborildi\n📚 Savollar: ${N} + 1 (nechtasini topdingiz?)\n📬 Yetkazildi: ${reached}\n🚫 Botni bloklagan: ${blocked}${onlyTo ? '' : '\n📣 Kanalga ham yuborildi'}`);
    return { reached, blocked, total: ids.length };
  }

  // ---------------------------------------------------------------- HAFTALIK HISOBOT
  const topicName = k => topics[k] || k;
  async function sendWeekly(onlyTo) {
    const db = (await loadDB()) || {};
    const ids = userIds(db), mon = mondayOf();
    const ranked = ids.filter(k => !db[k].isAdmin).sort((a, b) => (db[b].atoms || 0) - (db[a].atoms || 0));
    let sent = 0;
    for (const uid of (onlyTo ? [String(onlyTo)] : ids)) {
      const e = db[uid] || {}, w = e.week && e.week.m === mon ? e.week : { t: 0, c: 0 };
      if (!onlyTo && !w.t) continue;                                                // bu hafta faol bo'lmaganlarga yubormaymiz
      const weak = Object.entries(e.topicStats || {}).filter(([, s]) => s.total >= 3).map(([k, s]) => ({ k, p: Math.round(100 * s.correct / s.total) })).sort((a, b) => a.p - b.p)[0];
      const rank = ranked.indexOf(uid);
      const text = `📊 Haftalik hisobotingiz\n\n✅ Yechilgan savollar: ${w.t}\n🎯 Aniqlik: ${w.t ? Math.round(100 * w.c / w.t) : 0}%\n🏆 Reytingdagi o'rningiz: ${rank >= 0 ? `${rank + 1}-o'rin (${ranked.length} kishidan)` : '—'}\n` +
        (weak && weak.p < 70 ? `⚠️ Eng zaif mavzu: ${topicName(weak.k)} (${weak.p}%)\n\nShu mavzuni bu hafta takrorlang!` : `\n💪 Zaif mavzu yo'q — shunday davom eting!`);
      if ((await say(uid, text, true)).ok) sent++;
      await sleep(40);
    }
    return { sent };
  }

  // ---------------------------------------------------------------- AVTOMATIK (har daqiqada tekshiriladi)
  let running = false;
  async function tick() {
    if (running || !rtdb) return; running = true;
    try {
      const now = Date.now(), cur = tashkentMinutes(now);
      if ((await get('settings/daily/enabled')) !== false && cur >= DAILY_AT && cur < DAILY_AT + WINDOW_MIN) {
        const today = tashkentDay(now);
        const tx = await rtdb.ref('meta/daily/lastRunDay').transaction(c => (c === today ? undefined : today));
        if (tx.committed) { const r = await sendDaily(); console.log(`[kunlik] ${today}: yetkazildi ${r.reached}/${r.total}`); }
      }
      if (isSunday(now) && cur >= WEEKLY_AT && cur < WEEKLY_AT + WINDOW_MIN) {
        const mon = mondayOf(now);
        const tx = await rtdb.ref('meta/weekly/lastRunMon').transaction(c => (c === mon ? undefined : mon));
        if (tx.committed) { const r = await sendWeekly(); console.log(`[kunlik] haftalik hisobot: ${r.sent}`); }
      }
    } catch (e) { console.error('[kunlik] tick', e && e.message); } finally { running = false; }
  }
  if (rtdb) { const t = setInterval(tick, 60 * 1000); if (t.unref) t.unref(); }

  // ---------------------------------------------------------------- ADMIN (faqat botdan)
  app.post('/api/admin/daily', async (req, res) => {
    if (!INTERNAL_API_KEY) return res.status(503).json({ success: false, error: 'INTERNAL_API_KEY sozlanmagan' });
    if (!checkInternalKey(req, res)) return;
    const { adminUserId, action } = req.body || {}, aid = String(adminUserId || '');
    if (!(await isAuthorizedAdmin({ adminUserId: aid }))) return res.status(403).json({ success: false, error: 'Admin huquqi tasdiqlanmadi' });
    if (action === 'on' || action === 'off') { await rtdb.ref('settings/daily/enabled').set(action === 'on'); return res.json({ success: true, enabled: action === 'on' }); }
    if (running) return res.status(409).json({ success: false, error: 'Hozir yuborish ketyapti, biroz kuting' });
    if (!['send', 'test', 'weekly', 'weeklytest'].includes(action)) return res.status(400).json({ success: false, error: 'Noma\'lum amal' });
    running = true;
    res.json({ success: true });
    (async () => {
      if (action === 'send') { await rtdb.ref('meta/daily/lastRunDay').set(tashkentDay()); await sendDaily(); }
      else if (action === 'test') await sendDaily(aid);
      else if (action === 'weekly') { const r = await sendWeekly(); await say(aid, `✅ Haftalik hisobot yuborildi: ${r.sent} kishiga`); }
      else await sendWeekly(aid);
    })().catch(e => console.error('[kunlik]', e && e.message)).finally(() => { running = false; });
  });

  // ---------------------------------------------------------------- TAKLIF REYTINGI
  app.get('/api/referral-top', async (req, res) => {
    const db = (await loadDB()) || {}, cnt = {};
    Object.values(db).forEach(u => { if (u && u.referredBy) cnt[u.referredBy] = (cnt[u.referredBy] || 0) + 1; });
    const list = Object.keys(cnt).filter(k => db[k] && !db[k].isAdmin).sort((a, b) => cnt[b] - cnt[a]);
    const uid = String((req.query || {}).userId || '');
    res.json({
      top: list.slice(0, 10).map(k => ({ name: db[k].nickname || db[k].telegramFirstName || 'Foydalanuvchi', count: cnt[k] })),
      mine: { count: cnt[uid] || 0, rank: list.indexOf(uid) >= 0 ? list.indexOf(uid) + 1 : null }
    });
  });

  module.exports.__internal = { sendDaily, sendWeekly, mondayOf };
};
