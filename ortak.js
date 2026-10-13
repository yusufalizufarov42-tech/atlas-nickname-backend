// ============================================================================
//  ORTAK yordamchilar — sinf (sinf.js), guruh (guruh.js) va uy vazifasi (uyvazifa.js) modullari uchun.
//  Har bir modul:  const H = require('./ortak')(app, deps);   — bitta umumiy nusxa qaytadi.
//
//  Muhim qoidalar:
//   • Foydalanuvchi shaxsi FAQAT Telegram initData imzosidan olinadi (H.auth) — userId ni so'rovdan ishonib bo'lmaydi.
//   • Boshqa odamga FAQAT taxallus yoki Telegram ismi ko'rsatiladi (H.dname). To'liq ism va telefon HECH QACHON.
//   • Bildirishnomalar jim soatlarda (22:00–07:00 Toshkent) yuborilmaydi (force bo'lmasa).
// ============================================================================
'use strict';

module.exports = function ortak(app, deps) {
  if (app.locals.H) return app.locals.H;
  const { rtdb, loadDB } = deps;
  const BOT_TOKEN = deps.BOT_TOKEN;
  const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const APP_URL = process.env.MINI_APP_URL || 'https://yusufalizufarov42-tech.github.io/atlas-mini-app/';
  const BOT_USERNAME = (process.env.BOT_USERNAME || 'atlasilmbot').replace(/^@/, '');
  const H = { APP_URL, BOT_USERNAME };

  H.ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  H.rnd = (n = 6) => Array.from({ length: n }, () => H.ALPHA[Math.floor(Math.random() * H.ALPHA.length)]).join('');
  H.cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  H.uidOk = u => /^\d+$/.test(String(u || ''));
  H.sleep = ms => new Promise(r => setTimeout(r, ms));
  H.get = async p => (await rtdb.ref(p).once('value')).val();
  H.fail = (res, s, m) => res.status(s).json({ success: false, error: m });

  // ---- Toshkent vaqti
  H.tashDay = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(t));
  H.tashMin = (t = Date.now()) => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)).split(':').map(Number); return (h % 24) * 60 + m; };
  H.isSunday = (t = Date.now()) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tashkent', weekday: 'short' }).format(new Date(t)) === 'Sun';
  H.mondayOf = (t = Date.now()) => { const d = new Date(H.tashDay(t) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  H.quiet = (t = Date.now()) => { const m = H.tashMin(t); return m >= 22 * 60 || m < 7 * 60; };   // jim soatlar 22:00–07:00

  // ---- Autentifikatsiya: Telegram initData imzosi (header X-Init-Data yoki body.initData)
  H.authUid = req => {
    const v = app.locals.verifyInitData;
    if (!v) return null;
    return v(req.headers['x-init-data'] || (req.body && req.body.initData) || (req.query && req.query.initData));
  };
  H.auth = (req, res) => {
    const uid = H.authUid(req);
    if (!uid) { res.status(401).json({ success: false, error: "Telegram ichida oching (ilovani yopib qayta kiring)." }); return null; }
    return uid;
  };

  // ---- Foydalanuvchilar (qisqa muddat keshlanadi — qidiruv/reyting har safar butun bazani o'qimasin)
  let cache = { t: 0, v: null };
  H.users = async fresh => {
    const ttl = process.env.USERS_CACHE_MS !== undefined ? Number(process.env.USERS_CACHE_MS) : 15000;
    if (!fresh && cache.v && Date.now() - cache.t < ttl) return cache.v;
    const v = (await loadDB()) || {};
    cache = { t: Date.now(), v };
    return v;
  };
  // MAXFIYLIK: faqat taxallus yoki Telegram ismi. fullName/phone hech qachon chiqmaydi.
  H.dname = e => String((e && (e.nickname || e.telegramFirstName)) || "Foydalanuvchi").replace(/\s+/g, ' ').trim().slice(0, 30);
  H.isTeacher = e => !!(e && e.role === 'teacher');
  H.blocked = async uid => (await H.get('users/' + uid + '/blocked')) === true;
  H.verified = async uid => (await H.get('users/' + uid + '/verifiedTeacher')) === true;
  H.CAP_UNVERIFIED = 10; H.CAP_VERIFIED = 200;
  H.cap = async teacherId => ((await H.verified(teacherId)) ? H.CAP_VERIFIED : H.CAP_UNVERIFIED);
  H.cls = async code => (code ? H.get('classes/' + code) : null);
  H.members = async code => Object.keys((await H.get('class_members/' + code)) || {});
  H.alias = async code => {                                  // qidiruvda kod ko'rsatilmasligi uchun alohida qisqa nom
    const c = await H.get('classes/' + code);
    if (c && c.alias) return c.alias;
    for (let i = 0; i < 6; i++) {
      const a = H.rnd(8);
      const tx = await rtdb.ref('class_alias/' + a).transaction(cur => (cur ? undefined : code));
      if (tx.committed) { await rtdb.ref('classes/' + code + '/alias').set(a); return a; }
    }
    return null;
  };

  // Guruhga kirish huquqi: faqat a'zo yoki ustoz. {c, isTeacher} yoki {error:[status, matn]}
  H.access = async (code, uid) => {
    const c = await H.cls(code);
    if (!c) return { error: [404, 'Guruh topilmadi'] };
    if (await H.blocked(uid)) return { error: [403, 'Sizning hisobingiz cheklangan'] };
    const isTeacher = String(c.teacherId) === String(uid);
    if (!isTeacher && !(await H.get(`class_members/${code}/${uid}`))) return { error: [403, "Siz bu guruh a'zosi emassiz"] };
    if (!isTeacher && (await H.blocked(c.teacherId))) return { error: [403, 'Bu guruh vaqtincha yopilgan'] };
    return { c, isTeacher };
  };
  H.fmtDate = t => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)).replace(',', '');

  // ---- Telegram
  H.tg = async (method, body) => {
    if (!BOT_TOKEN) return { ok: false };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.ok) return { ok: true, result: j.result };
        if (j.error_code === 429 && j.parameters && j.parameters.retry_after) { await H.sleep(Math.min(j.parameters.retry_after, 15) * 1000 + 200); continue; }
        return { ok: false, blocked: j.error_code === 403 };
      } catch (e) { /* tarmoq xatosi — qayta urinamiz */ }
    }
    return { ok: false };
  };
  // Bildirishnoma. opt.force — jim soatlarni ham o'tkazib yuboradi (faqat admin ogohlantirishlari uchun).
  // opt.code — tugma shu guruhni ochadi; opt.open — Mini App ichida ochiladigan bo'lim ("class" | "hw"); opt.qs — tayyor ?param
  H.notify = async (uid, text, opt = {}) => {
    if (!opt.force && H.quiet()) return { ok: false, skipped: 'quiet' };
    if (!opt.force && (await H.get('users/' + uid + '/notifOff')) === true) return { ok: false, skipped: 'off' };
    const q = opt.qs || (opt.code ? '?guruh=' + encodeURIComponent(opt.code) : (opt.open ? '?open=' + encodeURIComponent(opt.open) : ''));
    const body = { chat_id: uid, text: String(text).slice(0, 3500) };
    if (!opt.noButton) body.reply_markup = { inline_keyboard: [[{ text: opt.btn || '📲 Ochish', web_app: { url: APP_URL + q } }]] };
    return H.tg('sendMessage', body);
  };
  H.notifyMany = async (uids, text, opt = {}) => {
    let sent = 0, skipped = 0;
    for (const u of uids) {
      const r = await H.notify(u, text, opt);
      if (r.ok) sent++; else skipped++;
      await H.sleep(40);
    }
    return { sent, skipped };
  };
  H.adminIds = async () => { const db = await H.users(); return Object.keys(db).filter(k => H.uidOk(k) && db[k] && db[k].isAdmin); };
  H.notifyAdmins = async text => { for (const a of await H.adminIds()) await H.notify(a, text, { force: true, noButton: true }); };

  // Telegram'ga fayl yuborish (CSV va h.k.) — Node 18+ da FormData/Blob mavjud
  H.sendDoc = async (chatId, filename, buffer, caption) => {
    if (!BOT_TOKEN) return { ok: false };
    try {
      const fd = new FormData();
      fd.append('chat_id', String(chatId));
      if (caption) fd.append('caption', String(caption).slice(0, 900));
      fd.append('document', new Blob([buffer], { type: 'text/csv' }), filename);
      const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
      const j = await r.json();
      return { ok: !!j.ok };
    } catch (e) { return { ok: false }; }
  };

  // ---- Guruh chatiga xabar yozish (chat ham, tizim e'lonlari ham shu orqali)
  H.addMsg = async (code, uid, text, kind = 'chat', extra = {}) => {
    const ref = rtdb.ref('class_msgs/' + code).push();
    const msg = Object.assign({ id: ref.key, uid: String(uid), text: String(text), kind, at: Date.now() }, extra);
    await ref.set(msg);
    if (Math.random() < 0.03) H.prune(code).catch(() => {});
    return msg;
  };
  H.prune = async (code, keep = 400) => {                    // eski xabarlarni tozalash (bazani to'ldirmaslik uchun)
    const all = (await H.get('class_msgs/' + code)) || {};
    const ids = Object.keys(all).sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    const del = ids.slice(0, Math.max(0, ids.length - keep));
    const pinned = await H.get('classes/' + code + '/pinned');
    for (const id of del) if (id !== pinned) await rtdb.ref(`class_msgs/${code}/${id}`).remove();
  };

  app.locals.H = H;
  return H;
};
