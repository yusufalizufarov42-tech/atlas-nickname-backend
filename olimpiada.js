// ============================================================================
//  OLIMPIADA moduli — server.js ga faqat BITTA qator qo'shiladi (tests ulangan joyning yonida):
//      require('./olimpiada')(app, { rtdb, BOT_TOKEN });
//
//  Ko'rinishlar:  public — ro'yxatda ko'rinadi, yaratilganda botdan hammaga taklif ketadi
//                 secret — "sirli": ro'yxatda yo'q, faqat kod bilan kiriladi; kirmagan odam
//                          faqat savollar sonini va mavzuni ko'radi  (eski 'private' ham shu)
//  Savollar javoblari serverda saqlanadi, tekshiruv ham serverda. Natijalar olimpiada
//  tugagach ochiladi.
//
//  Firebase RTDB:
//    olimp/{id}               meta (nom, vaqt, limit, ko'rinish, flags ...)
//    olimp_q/{id}             savollar (javoblari bilan — mijozga yuborilmaydi)
//    olimp_code/{KOD}         -> id
//    olimp_pub/{id}           -> createdAt (ochiq olimpiadalar indeksi)
//    olimp_mine/{uid}/{id}    -> createdAt (yaratuvchining ro'yxati)
//    olimp_join/{id}/{uid}    ishtirokchi
//    olimp_att/{id}/{uid}     urinish (javoblar, vaqt)
//    olimp_sched/{id}         bot xabarlari hali tugamagan olimpiadalar
//    olimp_daily/{uid}/{sana} kunlik yaratish hisobi
//    olimp_bday/{uid|_all}/{sana}  ommaviy taklif hisobi
//
//  Muhit o'zgaruvchilari (ixtiyoriy):
//    OLIMP_APP_URL          Mini App manzili (botdagi tugma shu yerga ochadi)
//    OLIMP_BROADCAST_IDS    vergul bilan Telegram ID'lar — berilsa, hammaga taklif FAQAT shularning
//                           ochiq olimpiadalari uchun ketadi (spamdan himoya)
// ============================================================================
'use strict';
const crypto = require('crypto');

module.exports = function mountOlimp(app, deps) {
  const { rtdb, BOT_TOKEN } = deps;
  const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const APP_URL = process.env.OLIMP_APP_URL || 'https://yusufalizufarov42-tech.github.io/atlas-mini-app/';
  const BROADCAST_IDS = (process.env.OLIMP_BROADCAST_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

  const DAILY_LIMIT = 3;                 // kuniga yaratiladigan olimpiadalar
  const BROADCAST_OWNER_DAILY = 1;       // bitta odam kuniga nechta ommaviy taklif yubora oladi
  const BROADCAST_GLOBAL_DAILY = 3;      // butun tizim bo'yicha kuniga
  const Q_MAX = 100, DUR_MIN = 5, DUR_MAX = 300, MAX_PART = 5000;
  const GRACE_MS = 60 * 1000;            // vaqt tugagach javob yuborishga beriladigan qo'shimcha vaqt
  const REMIND_MS = 10 * 60 * 1000;
  const AUTH_MAX_AGE_S = 48 * 3600;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  /* ---------- yordamchilar ---------- */
  const ok = (res, data) => res.json(Object.assign({ success: true }, data || {}));
  const fail = (res, status, error, extra) => res.status(status).json(Object.assign({ success: false, error }, extra || {}));
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[olimp]', req.path, e && e.stack || e);
    if (!res.headersSent) fail(res, 500, 'Serverda xatolik yuz berdi');
  });
  const get = async p => (await rtdb.ref(p).once('value')).val();
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmtTime = ms => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  const bump = async (p, limit) => (await rtdb.ref(p).transaction(c => ((c || 0) >= limit ? undefined : (c || 0) + 1))).committed;

  function phase(m, now) {
    now = now || Date.now();
    if (m.startAt == null) return 'waiting';
    if (now < m.startAt) return 'scheduled';
    if (now < m.endAt) return 'live';
    return 'ended';
  }

  /* ---------- Telegram tekshiruvi (tests.js bilan bir xil) ---------- */
  function verifyInitData(initData) {
    if (!BOT_TOKEN) return { error: 'BOT_TOKEN sozlanmagan' };
    if (typeof initData !== 'string' || !initData) return { error: 'Telegram orqali oching' };
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { error: 'initData noto\'g\'ri' };
    params.delete('hash');
    const dcs = [...params.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    const a = Buffer.from(calc, 'hex'), b = Buffer.from(String(hash), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'initData imzosi noto\'g\'ri' };
    const authDate = Number(params.get('auth_date'));
    if (!authDate || Date.now() / 1000 - authDate > AUTH_MAX_AGE_S) return { error: 'Sessiya eskirgan, ilovani qayta oching' };
    let user; try { user = JSON.parse(params.get('user')); } catch (e) { user = null; }
    if (!user || !user.id) return { error: 'Foydalanuvchi aniqlanmadi' };
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || 'Foydalanuvchi';
    return { user: { id: String(user.id), name: name.slice(0, 40), username: user.username || '' } };
  }
  function auth(req, res, next) {
    const r = verifyInitData((req.body || {}).initData);
    if (r.error) return fail(res, 401, r.error, { code: 'auth' });
    req.tg = r.user;
    next();
  }

  /* ---------- Telegram xabarlari ---------- */
  async function tgSend(chatId, text, buttonText, code) {
    const body = { chat_id: chatId, text };
    if (buttonText) body.reply_markup = { inline_keyboard: [[{ text: buttonText, web_app: { url: `${APP_URL}?olimp=${encodeURIComponent(code)}` } }]] };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.ok) return true;
        if (j.error_code === 429 && j.parameters && j.parameters.retry_after) { await sleep(Math.min(j.parameters.retry_after, 10) * 1000 + 200); continue; }
        return false; // 403 (bot bloklangan / start bosilmagan) va h.k.
      } catch (e) { return false; }
    }
    return false;
  }
  async function sendMany(ids, text, buttonText, code) {
    let sent = 0;
    for (const id of ids) { if (await tgSend(id, text, buttonText, code)) sent++; await sleep(45); }
    return sent;
  }
  const shortTitle = m => m.vis !== 'public' ? 'Sirli olimpiada' : `«${m.title}»`;
  function noticeText(m, kind) {
    if (kind === 'remind') return `⏰ ${shortTitle(m)} olimpiadasi 10 daqiqadan keyin boshlanadi (${fmtTime(m.startAt)}). Tayyor turing!`;
    if (kind === 'start') return `🏁 «${m.title}» olimpiadasi boshlandi!\n⏱ Tugash vaqti: ${fmtTime(m.endAt)}\nKirish uchun tugmani bosing.`;
    if (kind === 'end') return `✅ «${m.title}» olimpiadasi yakunlandi. Natijalar tayyor — tugmani bosib ko'ring.`;
    return '';
  }
  async function notifyJoined(m, kind) {
    const joins = (await get(`olimp_join/${m.id}`)) || {};
    const btn = kind === 'end' ? '📊 Natijalar' : kind === 'remind' ? '🏆 Olimpiada' : '▶ Kirish';
    return sendMany(Object.keys(joins), noticeText(m, kind), btn, m.code);
  }
  async function broadcastInvite(m) {
    if (BROADCAST_IDS.length && !BROADCAST_IDS.includes(m.ownerId)) return; // faqat ruxsat berilganlar
    const d = day();
    if (!(await bump(`olimp_bday/${m.ownerId}/${d}`, BROADCAST_OWNER_DAILY))) return;
    if (!(await bump(`olimp_bday/_all/${d}`, BROADCAST_GLOBAL_DAILY))) return;
    const users = (await get('users')) || {};
    const ids = Object.keys(users).filter(k => /^\d+$/.test(k));
    const text = `🏆 Yangi olimpiada!\n\n«${m.title}»\n📚 ${m.n} ta savol · ⏱ ${m.durationMin} daqiqa\n` +
      (m.startAt != null ? `🕒 Boshlanishi: ${fmtTime(m.startAt)}\n` : '🕒 Boshlanish vaqti keyinroq e\'lon qilinadi\n') +
      (m.max ? `👥 Joylar soni: ${m.max}\n` : '👥 Ishtirokchilar soni cheklanmagan\n') + '\nQatnashish uchun tugmani bosing.';
    await rtdb.ref(`olimp/${m.id}/flags/invite`).set(true);
    const sent = await sendMany(ids, text, '🏆 Qatnashish', m.code);
    console.log(`[olimp] taklif: ${m.id} ${sent}/${ids.length}`);
  }

  /* ---------- rejalashtirilgan xabarlar ---------- */
  async function processOne(id) {
    const m = await get(`olimp/${id}`);
    if (!m) { await rtdb.ref(`olimp_sched/${id}`).remove(); return; }
    const now = Date.now(), fl = m.flags || {};
    const flag = async k => (await rtdb.ref(`olimp/${id}/flags/${k}`).transaction(c => (c ? undefined : true))).committed;
    const ended = m.endAt != null && now >= m.endAt;
    if (m.startAt != null && !fl.remind && m.startAt > now && m.startAt - now <= REMIND_MS && m.startAt - m.createdAt > 2 * REMIND_MS) {
      if (await flag('remind')) await notifyJoined(m, 'remind');
    }
    if (m.startAt != null && now >= m.startAt && !fl.start) {
      if (await flag('start') && !ended) await notifyJoined(m, 'start');   // o'tib ketgan bo'lsa, eskirgan xabar yubormaymiz
    }
    if (ended && !fl.end) {
      if (await flag('end')) await notifyJoined(m, 'end');
      await rtdb.ref(`olimp_sched/${id}`).remove();
    }
  }
  let ticking = false;
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      const ids = Object.keys((await get('olimp_sched')) || {});
      for (const id of ids) { try { await processOne(id); } catch (e) { console.error('[olimp] tick', id, e && e.message); } }
    } catch (e) { console.error('[olimp] tick', e && e.message); }
    ticking = false;
  }
  if (rtdb) { const t = setInterval(tick, 20000); if (t.unref) t.unref(); }

  /* ---------- savollar va aralashtirish ---------- */
  function cleanQuestions(arr) {
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > Q_MAX) return { error: `Savollar soni 1 dan ${Q_MAX} gacha bo'lishi kerak` };
    const out = [];
    for (const raw of arr) {
      const x = raw || {};
      const q = str(x.q, 400), opts = (Array.isArray(x.opts) ? x.opts : []).slice(0, 4).map(o => str(o, 150)), a = Number(x.a);
      if (!q || opts.length < 2 || opts.some(o => !o) || !Number.isInteger(a) || a < 0 || a >= opts.length) return { error: `${out.length + 1}-savol noto'g'ri to'ldirilgan` };
      out.push({ q, opts, a, t: /^[a-z0-9_]{1,30}$/i.test(String(x.t || '')) ? String(x.t) : null });
    }
    return { qs: out };
  }
  // Har bir ishtirokchi uchun savollar va variantlar tartibi alohida (id+uid bo'yicha barqaror)
  function layout(qs, id, uid) {
    const h = crypto.createHash('sha256').update(id + ':' + uid).digest();
    let s = h.readUInt32LE(0) >>> 0;
    const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const shuf = n => { const a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    return shuf(qs.length).map(qi => ({ qi, perm: shuf(qs[qi].opts.length) }));
  }
  const fixAnswers = (arr, n) => Array.from({ length: n }, (_, i) => { const v = Array.isArray(arr) ? arr[i] : -1; return Number.isInteger(v) && v >= 0 && v < 4 ? v : -1; });
  function correctCount(qs, lay, answers) {
    let c = 0;
    lay.forEach((L, p) => { const v = answers[p]; if (v >= 0 && v < L.perm.length && L.perm[v] === qs[L.qi].a) c++; });
    return c;
  }

  /* ---------- ko'rinish (sirli olimpiadada ma'lumot yashiriladi) ---------- */
  function view(m, uid, joined) {
    const ph = phase(m), owner = m.ownerId === uid;
    const v = { id: m.id, vis: m.vis === 'public' ? 'public' : 'secret', phase: ph, n: m.n, topics: m.topics || [], subject: m.subject || '', isOwner: owner, joined: !!joined };
    if (m.vis !== 'public' && !owner && !joined && ph !== 'ended') { v.locked = true; return v; }
    const hide = m.vis !== 'public' && !owner && (ph === 'waiting' || ph === 'scheduled');
    Object.assign(v, { title: hide ? 'Sirli olimpiada' : m.title, ownerName: hide ? '' : m.ownerName, startAt: m.startAt, endAt: m.endAt, durationMin: m.durationMin, max: m.max, count: m.joined || 0 });
    if (owner) v.code = m.code;
    return v;
  }
  async function resolve(b, uid) {
    let id = null, viaCode = false;
    if (b.code) { const code = String(b.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); if (code) { id = await get(`olimp_code/${code}`); viaCode = true; } }
    else if (b.id) id = String(b.id).replace(/[^a-f0-9]/g, '').slice(0, 16);
    if (!id) return null;
    const m = await get(`olimp/${id}`);
    if (!m) return null;
    if (!viaCode && m.vis !== 'public' && m.ownerId !== uid && !(await get(`olimp_join/${id}/${uid}`))) return null;
    return m;
  }
  const notFound = res => fail(res, 404, 'Olimpiada topilmadi. Kodni tekshiring.');

  /* ===================== ENDPOINTLAR ===================== */
  app.post('/api/olimp/create', auth, wrap(async (req, res) => {
    const b = req.body || {}, uid = req.tg.id, now = Date.now();
    const title = str(b.title, 60);
    if (title.length < 3) return fail(res, 400, 'Olimpiada nomini yozing (kamida 3 belgi)');
    if (b.vis === 'private') b.vis = 'secret';          // shaxsiy va sirli — bitta tur
    if (!['public', 'secret'].includes(b.vis)) return fail(res, 400, 'Ko\'rinish turini tanlang');
    const subject = str(b.subject, 60);
    const dur = parseInt(b.durationMin, 10);
    if (!(dur >= DUR_MIN && dur <= DUR_MAX)) return fail(res, 400, `Davomiylik ${DUR_MIN}–${DUR_MAX} daqiqa bo'lsin`);
    const max = Math.max(0, Math.min(MAX_PART, parseInt(b.max, 10) || 0));
    let startAt = null;
    if (b.startMode !== 'manual') {
      startAt = Number(b.startAt);
      if (!Number.isFinite(startAt) || startAt < now - 60000 || startAt > now + 90 * 86400000) return fail(res, 400, 'Boshlanish vaqti noto\'g\'ri (90 kundan oshmasin, o\'tib ketmasin)');
      startAt = Math.round(startAt);
    }
    const cq = cleanQuestions(b.questions);
    if (cq.error) return fail(res, 400, cq.error);
    if (!(await bump(`olimp_daily/${uid}/${day()}`, DAILY_LIMIT))) return fail(res, 429, `Kuniga ${DAILY_LIMIT} tadan ko'p olimpiada yaratib bo'lmaydi`);

    const id = crypto.randomBytes(6).toString('hex');
    let code = '';
    for (let i = 0; i < 8 && !code; i++) {
      const c = Array.from(crypto.randomBytes(6), x => CODE_CHARS[x % CODE_CHARS.length]).join('');
      if (!(await get(`olimp_code/${c}`))) code = c;
    }
    if (!code) return fail(res, 500, 'Kod yaratib bo\'lmadi, qayta urining');
    const topics = [...new Set(cq.qs.map(q => q.t).filter(Boolean))].slice(0, 40);
    const m = { id, code, ownerId: uid, ownerName: req.tg.name, title, subject, vis: b.vis, startAt, endAt: startAt == null ? null : startAt + dur * 60000,
      durationMin: dur, max, n: cq.qs.length, topics, createdAt: now, joined: 0, flags: {} };
    await rtdb.ref(`olimp/${id}`).set(m);
    await rtdb.ref(`olimp_q/${id}`).set(cq.qs);
    await rtdb.ref(`olimp_code/${code}`).set(id);
    await rtdb.ref(`olimp_mine/${uid}/${id}`).set(now);
    await rtdb.ref(`olimp_sched/${id}`).set(true);
    if (m.vis === 'public') {
      await rtdb.ref(`olimp_pub/${id}`).set(now);
      broadcastInvite(m).catch(e => console.error('[olimp] invite', e && e.message));
    }
    ok(res, { olimp: view(m, uid, false), id, code });
  }));

  app.post('/api/olimp/public', auth, wrap(async (req, res) => {
    const idx = (await get('olimp_pub')) || {}, now = Date.now();
    const ids = Object.keys(idx).sort((a, b) => idx[b] - idx[a]).slice(0, 60);
    const metas = (await Promise.all(ids.map(id => get(`olimp/${id}`)))).filter(Boolean);
    const list = metas.map(m => ({ m, ph: phase(m, now) })).filter(x => x.ph !== 'ended' || now - x.m.endAt < 86400000);
    const rank = { live: 0, scheduled: 1, waiting: 2, ended: 3 };
    list.sort((a, b) => rank[a.ph] - rank[b.ph] || (a.m.startAt || 9e15) - (b.m.startAt || 9e15));
    ok(res, { list: list.map(x => view(x.m, req.tg.id, false)) });
  }));

  app.post('/api/olimp/mine', auth, wrap(async (req, res) => {
    const idx = (await get(`olimp_mine/${req.tg.id}`)) || {};
    const ids = Object.keys(idx).sort((a, b) => idx[b] - idx[a]).slice(0, 50);
    const metas = (await Promise.all(ids.map(id => get(`olimp/${id}`)))).filter(Boolean);
    ok(res, { list: metas.map(m => view(m, req.tg.id, false)) });
  }));

  app.post('/api/olimp/info', auth, wrap(async (req, res) => {
    const m = await resolve(req.body || {}, req.tg.id);
    if (!m) return notFound(res);
    const j = await get(`olimp_join/${m.id}/${req.tg.id}`);
    ok(res, { olimp: view(m, req.tg.id, j) });
  }));

  app.post('/api/olimp/join', auth, wrap(async (req, res) => {
    const uid = req.tg.id;
    const m = await resolve(req.body || {}, uid);
    if (!m) return notFound(res);
    if (phase(m) === 'ended') return fail(res, 409, 'Olimpiada tugagan');
    if (await get(`olimp_join/${m.id}/${uid}`)) return ok(res, { olimp: view(m, uid, true) });
    const tx = await rtdb.ref(`olimp/${m.id}/joined`).transaction(c => ((m.max && (c || 0) >= m.max) ? undefined : (c || 0) + 1));
    if (!tx.committed) return fail(res, 409, 'Joylar tugagan');
    const name = (await get(`users/${uid}/fullName`)) || req.tg.name;
    await rtdb.ref(`olimp_join/${m.id}/${uid}`).set({ name: str(name, 40), username: req.tg.username || '', at: Date.now() });
    const fresh = await get(`olimp/${m.id}`);
    ok(res, { olimp: view(fresh, uid, true) });
  }));

  async function ownerOnly(req, res) {
    const m = await resolve(req.body || {}, req.tg.id);
    if (!m) { notFound(res); return null; }
    if (m.ownerId !== req.tg.id) { fail(res, 403, 'Bu amal faqat yaratuvchiga ruxsat etilgan'); return null; }
    return m;
  }
  app.post('/api/olimp/start-now', auth, wrap(async (req, res) => {
    const m = await ownerOnly(req, res); if (!m) return;
    const ph = phase(m);
    if (ph === 'live') return fail(res, 409, 'Olimpiada allaqachon boshlangan');
    if (ph === 'ended') return fail(res, 409, 'Olimpiada tugagan');
    const now = Date.now();
    await rtdb.ref(`olimp/${m.id}`).update({ startAt: now, endAt: now + m.durationMin * 60000 });
    await rtdb.ref(`olimp_sched/${m.id}`).set(true);
    processOne(m.id).catch(() => {});
    ok(res, { olimp: view(await get(`olimp/${m.id}`), req.tg.id, false) });
  }));
  app.post('/api/olimp/finish-now', auth, wrap(async (req, res) => {
    const m = await ownerOnly(req, res); if (!m) return;
    if (phase(m) !== 'live') return fail(res, 409, 'Olimpiada hozir davom etmayapti');
    await rtdb.ref(`olimp/${m.id}`).update({ endAt: Date.now() });
    await rtdb.ref(`olimp_sched/${m.id}`).set(true);
    processOne(m.id).catch(() => {});
    ok(res, { olimp: view(await get(`olimp/${m.id}`), req.tg.id, false) });
  }));

  app.post('/api/olimp/begin', auth, wrap(async (req, res) => {
    const uid = req.tg.id, m = await resolve(req.body || {}, uid);
    if (!m) return notFound(res);
    if (!(await get(`olimp_join/${m.id}/${uid}`))) return fail(res, 403, 'Avval olimpiadaga qo\'shiling');
    const ph = phase(m);
    if (ph !== 'live') return fail(res, 409, ph === 'ended' ? 'Olimpiada tugagan' : 'Olimpiada hali boshlanmagan');
    const qs = await get(`olimp_q/${m.id}`) || [];
    const lay = layout(qs, m.id, uid);
    let att = await get(`olimp_att/${m.id}/${uid}`);
    if (!att) { att = { startedAt: Date.now(), answers: [], submitted: false }; await rtdb.ref(`olimp_att/${m.id}/${uid}`).set(att); }
    ok(res, {
      title: m.title, endAt: m.endAt, serverNow: Date.now(), submitted: !!att.submitted,
      answers: fixAnswers(att.answers, qs.length),
      questions: lay.map(L => ({ q: qs[L.qi].q, opts: L.perm.map(i => qs[L.qi].opts[i]), t: qs[L.qi].t }))
    });
  }));

  app.post('/api/olimp/save', auth, wrap(async (req, res) => {
    const uid = req.tg.id, m = await resolve(req.body || {}, uid);
    if (!m) return notFound(res);
    if (!(await get(`olimp_join/${m.id}/${uid}`))) return fail(res, 403, 'Siz bu olimpiadada ishtirokchi emassiz');
    const now = Date.now();
    if (m.startAt == null || now < m.startAt || now > m.endAt + GRACE_MS) return fail(res, 409, 'Vaqt tugagan');
    const att = await get(`olimp_att/${m.id}/${uid}`);
    if (!att) return fail(res, 409, 'Avval olimpiadani boshlang');
    if (att.submitted) return ok(res, { submitted: true });
    const answers = fixAnswers((req.body || {}).answers, m.n);
    const upd = { answers, at: now };
    if ((req.body || {}).final === true) upd.submitted = true;
    await rtdb.ref(`olimp_att/${m.id}/${uid}`).update(upd);
    ok(res, { submitted: !!upd.submitted });
  }));

  const resultCache = new Map();
  async function computeBoard(m) {
    const cached = resultCache.get(m.id);
    if (cached) return cached;
    const [qs, joins, atts] = await Promise.all([get(`olimp_q/${m.id}`), get(`olimp_join/${m.id}`), get(`olimp_att/${m.id}`)]);
    const rows = Object.keys(joins || {}).map(uid => {
      const a = (atts || {})[uid];
      let correct = 0, time = null;
      if (a && a.answers) { correct = correctCount(qs, layout(qs, m.id, uid), fixAnswers(a.answers, qs.length)); time = (a.at || a.startedAt || m.endAt) - m.startAt; }
      return { uid, name: joins[uid].name, username: joins[uid].username || '', correct, time, took: !!a };
    });
    rows.sort((x, y) => y.correct - x.correct || (x.time == null) - (y.time == null) || (x.time || 0) - (y.time || 0));
    rows.forEach((r, i) => { r.rank = i + 1; });
    const board = { qs, rows };
    if (Date.now() > m.endAt + GRACE_MS) resultCache.set(m.id, board);
    return board;
  }

  app.post('/api/olimp/results', auth, wrap(async (req, res) => {
    const uid = req.tg.id, m = await resolve(req.body || {}, uid);
    if (!m) return notFound(res);
    const ph = phase(m), owner = m.ownerId === uid;
    const joined = !!(await get(`olimp_join/${m.id}/${uid}`));
    if (ph !== 'ended') {
      if (!owner) return fail(res, 409, 'Natijalar olimpiada tugagach ochiladi');
      const joins = (await get(`olimp_join/${m.id}`)) || {};
      return ok(res, { ended: false, participants: Object.values(joins).sort((a, b) => a.at - b.at).slice(0, 300).map(j => ({ name: j.name, username: j.username })) });
    }
    if (!joined && !owner) return fail(res, 403, 'Natijalarni faqat ishtirokchilar ko\'ra oladi');
    const { qs, rows } = await computeBoard(m);
    const pub = r => ({ rank: r.rank, name: r.name, username: r.username, correct: r.correct, time: r.time, took: r.took });
    const out = { ended: true, n: m.n, total: rows.length, top: rows.slice(0, 50).map(pub) };
    if (owner) out.all = rows.slice(0, 500).map(pub);
    const me = rows.find(r => r.uid === uid);
    if (me) {
      out.me = pub(me);
      const att = await get(`olimp_att/${m.id}/${uid}`);
      if (att && att.answers) {
        const lay = layout(qs, m.id, uid), ans = fixAnswers(att.answers, qs.length);
        out.review = lay.map((L, p) => {
          const q = qs[L.qi], opts = L.perm.map(i => q.opts[i]);
          return { q: q.q, opts, mine: ans[p], correct: L.perm.indexOf(q.a) };
        });
      }
    }
    ok(res, out);
  }));

  // test va diagnostika uchun
  module.exports.__internal = { phase, layout, correctCount, fixAnswers, cleanQuestions, processOne, tick, view, noticeText };
};
