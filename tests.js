// Atlas Kimyo — Testlar moduli
//
//  • 43 talik Rasch mock (1–32 A–D, 33–35 A–F, 36–40 ochiq, 41–43 ko'p qismli ochiq)
//  • Javobli test (30 / 50 / 90 / 100 ta savol, ball: bir xil / alohida / guruhlab)
//
// Foydalanuvchi Telegram Mini App'ning imzolangan `initData`si orqali aniqlanadi
// (BOT_TOKEN bilan tekshiriladi), shuning uchun boshqa odamning nomidan
// so'rov yuborib bo'lmaydi.
//
// Ulash (server.js ichida, app.listen'dan oldin):
//     require('./tests')(app, { rtdb, BOT_TOKEN });
//
// Firebase Realtime Database yo'llari:
//   tests/{id}                  test (savollar tuzilmasi, kalit, ball, holat)
//   tests_by_code/{KOD}         kod -> test id
//   tests_by_owner/{uid}/{id}   yaratuvchining testlari
//   test_opened/{uid}/{id}      foydalanuvchi kod bilan ochgan testlar
//   attempts/{id}/{uid}         urinishlar (javoblar, vaqtlar)
//   test_results/{id}           yakunlangandagi natijalar
//   test_daily/{uid}/{sana}     kunlik yaratish hisobi

'use strict';
const crypto = require('crypto');
const path = require('path');

module.exports = function mountTests(app, deps) {
  const { rtdb, BOT_TOKEN } = deps;

  /* ===================== SOZLAMALAR ===================== */
  const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const DAILY_LIMIT = 3;                       // bir kunda yaratiladigan testlar
  const SIMPLE_COUNTS = [30, 50, 90, 100];     // javobli test savollar soni
  const DUR_MIN = 10, DUR_MAX = 300;           // davomiylik (daqiqa)
  const MAX_FILE_BYTES = 9 * 1024 * 1024;      // savollar fayli
  const GRACE_MS = 60 * 1000;                  // vaqt tugagach yuborishga beriladigan qo'shimcha vaqt
  const MIN_PARTICIPANTS = { rasch: 2, simple: 1 };
  const PTS_MAX = 20;
  const AUTH_MAX_AGE_S = 48 * 3600;

  // Rasch ballini 0–100 shkalaga o'tkazish (namuna formula, sozlanadi):
  //   ball = SCALE_MID + SCALE_SLOPE * logit
  const SCALE_MID = Number(process.env.TESTS_SCALE_MID) || 50;
  const SCALE_SLOPE = Number(process.env.TESTS_SCALE_SLOPE) || 12;
  // Milliy sertifikat darajalari: [eng past ball, daraja]. Rasmiy shkala o'zgarsa, shu yerni tahrirlang.
  const LEVELS = [[70, 'A+'], [65, 'A'], [60, 'B+'], [55, 'B'], [50, 'C+'], [46, 'C']];

  const LETTERS4 = ['A', 'B', 'C', 'D'];
  const LETTERS6 = ['A', 'B', 'C', 'D', 'E', 'F'];
  const PART_LABELS = ['a', 'b', 'c', 'd', 'e'];

  /* ===================== YORDAMCHILAR ===================== */
  const round2 = v => Math.round(v * 100) / 100;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sigmoid = x => 1 / (1 + Math.exp(-x));
  const ok = (res, data) => res.json(Object.assign({ success: true }, data || {}));
  const fail = (res, status, error, extra) => res.status(status).json(Object.assign({ success: false, error }, extra || {}));
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[tests]', req.path, e && e.stack || e);
    if (!res.headersSent) fail(res, 500, 'Serverda xatolik yuz berdi');
  });
  const get = async p => (await rtdb.ref(p).once('value')).val();
  const tashkentDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());

  /* ===================== TELEGRAM AUTH ===================== */
  function verifyInitData(initData) {
    if (!BOT_TOKEN) return { error: 'BOT_TOKEN sozlanmagan' };
    if (typeof initData !== 'string' || !initData) return { error: 'Telegram orqali oching' };
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { error: 'initData noto\'g\'ri' };
    params.delete('hash');
    const dcs = [...params.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    const a = Buffer.from(calc, 'hex'), b = Buffer.from(String(hash), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'initData imzosi noto\'g\'ri' };
    const authDate = Number(params.get('auth_date'));
    if (!authDate || Date.now() / 1000 - authDate > AUTH_MAX_AGE_S) return { error: 'Sessiya eskirgan, ilovani qayta oching' };
    let user;
    try { user = JSON.parse(params.get('user')); } catch (e) { user = null; }
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

  /* ===================== TELEGRAM API ===================== */
  async function tgSendDocument(chatId, buf, filename, mime, caption) {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) fd.append('caption', caption);
    fd.append('document', new Blob([buf], { type: mime || 'application/octet-stream' }), filename);
    const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
    return r.json();
  }
  async function tgGetFile(fileId) {
    const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const j = await r.json();
    if (!j.ok) return null;
    const f = await fetch(`${TG_API}/file/bot${BOT_TOKEN}/${j.result.file_path}`);
    if (!f.ok) return null;
    return Buffer.from(await f.arrayBuffer());
  }

  /* ===================== TEST TUZILMASI ===================== */
  function parseParts(raw) {
    const parts = {};
    for (const q of [41, 42, 43]) {
      const n = parseInt(raw && raw[q], 10);
      if (!(n >= 2 && n <= 5)) return null;
      parts[q] = n;
    }
    return parts;
  }
  function structure(type, opts) {
    const items = [];
    if (type === 'rasch') {
      for (let q = 1; q <= 32; q++) items.push({ id: 'q' + q, q, label: String(q), type: 'mcq4' });
      for (let q = 33; q <= 35; q++) items.push({ id: 'q' + q, q, label: String(q), type: 'mcq6' });
      for (let q = 36; q <= 40; q++) items.push({ id: 'q' + q, q, label: String(q), type: 'open' });
      for (const q of [41, 42, 43])
        for (let k = 0; k < opts.parts[q]; k++)
          items.push({ id: 'q' + q + PART_LABELS[k], q, part: PART_LABELS[k], label: q + PART_LABELS[k], type: 'open' });
    } else {
      for (let q = 1; q <= opts.n; q++) items.push({ id: 'q' + q, q, label: String(q), type: 'mcq4' });
    }
    return items;
  }
  function applyKeys(items, keys) {
    const missing = [];
    items.forEach(it => {
      const v = keys && keys[it.id];
      if (it.type === 'open') {
        let arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split('|') : []);
        arr = arr.map(s => String(s).trim()).filter(Boolean).slice(0, 6).map(s => s.slice(0, 60));
        if (!arr.length) missing.push(it.label); else it.key = arr;
      } else {
        const L = it.type === 'mcq4' ? LETTERS4 : LETTERS6;
        const s = Array.isArray(v) ? v[0] : v;
        if (!L.includes(s)) missing.push(it.label); else it.key = [s];
      }
    });
    return missing;
  }
  const missingMsg = m => `Javob kaliti to'liq emas: ${m.length} ta maydon (${m.slice(0, 8).join(', ')}${m.length > 8 ? ', …' : ''}).`;

  /* ---- javobli test uchun ball tizimi ---- */
  function applyScoring(items, sc) {
    const n = items.length, errs = [];
    const okp = v => typeof v === 'number' && isFinite(v) && v > 0 && v <= PTS_MAX;
    const num = v => parseFloat(String(v).replace(',', '.'));
    const mode = sc && sc.mode;
    if (mode === 'same') {
      const p = num(sc.same);
      if (!okp(p)) errs.push(`Har bir savol uchun ball 0 dan katta va ${PTS_MAX} dan oshmasligi kerak.`);
      else items.forEach(it => { it.pts = round2(p); });
      return { errs, scoring: { mode, same: round2(p) } };
    }
    if (mode === 'each') {
      const bad = [];
      items.forEach(it => {
        const p = num(sc.each && sc.each[it.id]);
        if (!okp(p)) bad.push(it.label); else it.pts = round2(p);
      });
      if (bad.length) errs.push(`Ball belgilanmagan yoki noto'g'ri: ${bad.length} ta savol (${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ', …' : ''}).`);
      return { errs, scoring: { mode } };
    }
    if (mode === 'group') {
      const gs = (Array.isArray(sc.groups) ? sc.groups : []).map(g => ({ from: parseInt(g.from, 10), to: parseInt(g.to, 10), pts: num(g.pts) }));
      if (!gs.length) errs.push("Kamida bitta guruh qo'shing.");
      const cover = new Array(n + 1).fill(0);
      let bad = false, overlap = false;
      gs.forEach(g => {
        if (!(g.from >= 1 && g.to <= n && g.from <= g.to && okp(g.pts))) { bad = true; return; }
        for (let q = g.from; q <= g.to; q++) { if (cover[q]) overlap = true; cover[q]++; }
      });
      if (bad) errs.push(`Guruhlarda xato bor: savol raqamlari 1–${n} oralig'ida, «dan» ≤ «gacha» va ball 0 dan katta bo'lishi kerak.`);
      if (overlap) errs.push('Guruhlar bir-biri bilan kesishmasin.');
      const covered = cover.slice(1).filter(Boolean).length;
      if (covered < n) errs.push(`Guruhlar hamma savolni qamrab olishi kerak (qamrab olingan: ${covered}/${n}).`);
      if (!errs.length) items.forEach(it => { const g = gs.find(g => it.q >= g.from && it.q <= g.to); it.pts = round2(g.pts); });
      return { errs, scoring: { mode, groups: gs.map(g => ({ from: g.from, to: g.to, pts: round2(g.pts) })) } };
    }
    return { errs: ["Ball berish usulini tanlang."], scoring: null };
  }
  const sumPts = items => round2(items.reduce((a, it) => a + (it.pts > 0 ? it.pts : 0), 0));
  function scoringText(t) {
    if (t.type !== 'simple' || !t.scoring) return '';
    const sc = t.scoring;
    const f = v => String(round2(v));
    let s;
    if (sc.mode === 'same') s = `Hammasiga bir xil: ${f(sc.same)} ball`;
    else if (sc.mode === 'each') { const v = t.items.map(i => i.pts); s = `Har biriga alohida (${f(Math.min(...v))}–${f(Math.max(...v))} ball)`; }
    else s = 'Guruhlab: ' + (sc.groups || []).map(g => `${g.from}–${g.to}: ${f(g.pts)} ball`).join(' · ');
    return s + ` · Jami: ${f(sumPts(t.items))} ball`;
  }

  /* ===================== JAVOBNI TEKSHIRISH ===================== */
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[\u2080-\u2089]/g, c => String(c.charCodeAt(0) - 0x2080))
      .replace(/\u00b2/g, '2').replace(/\u00b3/g, '3').replace(/\u00b9/g, '1')
      .replace(/[\u2070\u2074-\u2079]/g, c => c === '\u2070' ? '0' : String(c.charCodeAt(0) - 0x2070))
      .replace(/[\u2212\u2013\u2014]/g, '-').replace(/\s+/g, '').replace(/,/g, '.').replace(/\.$/, '');
  }
  function isCorrect(item, ans, tol) {
    const a = (ans == null ? '' : String(ans)).trim();
    if (!a) return false;
    const key = item.key || [];
    if (item.type !== 'open') return a === key[0];
    const T = tol || 0, isNum = x => /^-?\d+(\.\d+)?$/.test(x);
    const na = norm(a), fa = isNum(na) ? parseFloat(na) : NaN;
    return key.some(k => {
      const nk = norm(k);
      if (!nk) return false;
      if (nk === na) return true;
      const fk = isNum(nk) ? parseFloat(nk) : NaN;
      return isFinite(fa) && isFinite(fk) && Math.abs(fa - fk) <= T + 1e-9;
    });
  }

  /* ===================== RASCH (JMLE, dixotomik) ===================== */
  function raschEstimate(X) {
    const P = X.length, L = X[0].length;
    const s = X.map(r => r.reduce((a, b) => a + b, 0));
    const r = new Array(L).fill(0);
    X.forEach(row => row.forEach((v, i) => { r[i] += v; }));
    // hammasi to'g'ri / hammasi xato bo'lsa cheksiz qiymat chiqmasligi uchun ±0.5 tuzatish
    const sA = s.map(v => v === 0 ? 0.5 : v === L ? L - 0.5 : v);
    const rA = r.map(v => v === 0 ? 0.5 : v === P ? P - 0.5 : v);
    let th = sA.map(v => Math.log(v / (L - v)));
    let b = rA.map(v => Math.log((P - v) / v));
    const center = () => {
      const m = b.reduce((a, c) => a + c, 0) / L;
      b = b.map(v => v - m); th = th.map(v => v - m);
    };
    center();
    for (let it = 0; it < 200; it++) {
      let maxd = 0;
      for (let p = 0; p < P; p++) {
        let e = 0, w = 0;
        for (let i = 0; i < L; i++) { const pr = sigmoid(th[p] - b[i]); e += pr; w += pr * (1 - pr); }
        const d = clamp((sA[p] - e) / Math.max(w, 0.05), -1, 1);
        th[p] += d; maxd = Math.max(maxd, Math.abs(d));
      }
      for (let i = 0; i < L; i++) {
        let e = 0, w = 0;
        for (let p = 0; p < P; p++) { const pr = sigmoid(th[p] - b[i]); e += pr; w += pr * (1 - pr); }
        const d = clamp((e - rA[i]) / Math.max(w, 0.05), -1, 1);
        b[i] += d; maxd = Math.max(maxd, Math.abs(d));
      }
      center();
      if (maxd < 1e-4) break;
    }
    // JMLE siljishini tuzatish, so'ng qiyinliklar aniq deb qobiliyatni qayta topish
    b = b.map(v => v * (L - 1) / L);
    th = sA.map(sv => {
      let t = Math.log(sv / (L - sv));
      for (let k = 0; k < 60; k++) {
        let e = 0, w = 0;
        for (let i = 0; i < L; i++) { const pr = sigmoid(t - b[i]); e += pr; w += pr * (1 - pr); }
        t += clamp((sv - e) / Math.max(w, 0.05), -1, 1);
      }
      return t;
    });
    return { theta: th, b, raw: s };
  }
  const ballFromTheta = t => clamp(SCALE_MID + SCALE_SLOPE * t, 0, 100);
  function levelOf(ball) {
    const rb = round2(ball);
    for (const [min, name] of LEVELS) if (rb >= min) return name;
    return null;
  }

  /* ===================== NATIJALARNI HISOBLASH ===================== */
  function computeResults(t, attempts) {
    const items = t.items;
    const people = attempts.map(a => {
      const ans = a.answers || {};
      return {
        userId: a.userId, name: a.name, username: a.username || '',
        row: items.map(it => isCorrect(it, ans[it.id], t.tol) ? 1 : 0),
        time: Math.max(1, Math.round((a.submittedAt - a.startedAt) / 1000))
      };
    });
    const pct = items.map((_, i) => people.reduce((a, p) => a + p.row[i], 0) / people.length);
    const out = { computedAt: Date.now(), type: t.type, n: people.length };
    if (t.type === 'rasch') {
      const est = raschEstimate(people.map(p => p.row));
      people.forEach((p, k) => {
        p.raw = est.raw[k]; p.theta = round2(est.theta[k]);
        p.ball = round2(ballFromTheta(est.theta[k])); p.level = levelOf(p.ball);
      });
      people.sort((a, b) => b.ball - a.ball || b.raw - a.raw || a.time - b.time);
      out.items = items.map((it, i) => ({ id: it.id, label: it.label, pct: round2(pct[i]), b: round2(est.b[i]) }));
    } else {
      people.forEach(p => {
        p.raw = p.row.reduce((a, b) => a + b, 0);
        p.pts = round2(p.row.reduce((a, b, i) => a + b * items[i].pts, 0));
      });
      people.sort((a, b) => b.pts - a.pts || a.time - b.time);
      out.max = sumPts(items);
      out.items = items.map((it, i) => ({ id: it.id, label: it.label, pct: round2(pct[i]), pts: it.pts, key: it.key[0] }));
    }
    out.people = people.map(p => { const c = Object.assign({}, p); delete c.row; return c; });
    return out;
  }
  const publicPerson = p => { const c = Object.assign({}, p); delete c.userId; return c; };

  /* ===================== TEST / URINISH ===================== */
  function normCode(s) {
    s = String(s || '').toUpperCase().replace(/\s+/g, '');
    const m = s.match(/^([A-Z]+)-?(\d+)$/);
    return m ? m[1] + '-' + m[2] : s;
  }
  async function getTest(id) {
    if (!id || !/^[a-f0-9]{12}$/.test(String(id))) return null;
    const t = await get('tests/' + id);
    if (!t) return null;
    t.items = Array.isArray(t.items) ? t.items.filter(Boolean) : Object.values(t.items || {});
    return t;
  }
  const publicView = t => ({
    id: t.id, code: t.code, type: t.type, title: t.title, creatorName: t.ownerName,
    durationMin: t.durationMin, status: t.status, n: t.items.length, hasFile: !!t.file,
    items: t.items.map(it => ({ id: it.id, q: it.q, label: it.label, type: it.type, part: it.part || null }))
  });
  const ownerView = t => Object.assign(publicView(t), {
    parts: t.parts || null, tol: t.tol || 0, scoring: t.scoring || null, scoringText: scoringText(t),
    max: t.type === 'simple' ? sumPts(t.items) : null,
    file: t.file ? { name: t.file.name, mime: t.file.mime } : null,
    createdAt: t.createdAt, closedAt: t.closedAt || null,
    items: t.items.map(it => ({ id: it.id, q: it.q, label: it.label, type: it.type, part: it.part || null, key: it.key, pts: it.pts || null }))
  });
  async function getAttempt(tid, uid) {
    const a = await get(`attempts/${tid}/${uid}`);
    if (!a) return null;
    a.answers = a.answers || {};
    if (!a.submittedAt && Date.now() > a.deadline + GRACE_MS) {           // vaqt tugagan — o'zi topshirilgan hisoblanadi
      a.submittedAt = a.deadline; a.auto = true;
      await rtdb.ref(`attempts/${tid}/${uid}`).update({ submittedAt: a.submittedAt, auto: true });
    }
    return a;
  }
  const attemptView = a => a
    ? { started: true, startedAt: a.startedAt, deadline: a.deadline, submitted: !!a.submittedAt, submittedAt: a.submittedAt || null, answers: a.answers || {} }
    : { started: false };
  function sanitizeAnswers(t, answers) {
    const out = {};
    if (!answers || typeof answers !== 'object') return out;
    t.items.forEach(it => {
      if (!(it.id in answers)) return;
      let v = String(answers[it.id] == null ? '' : answers[it.id]).trim().slice(0, 80);
      if (it.type !== 'open') { const L = it.type === 'mcq4' ? LETTERS4 : LETTERS6; if (!L.includes(v)) v = ''; }
      out[it.id] = v;
    });
    return out;
  }
  function scoreSimple(t, answers) {
    let n = 0, pts = 0;
    t.items.forEach(it => { if (isCorrect(it, (answers || {})[it.id], t.tol)) { n++; pts += it.pts; } });
    return { pts: round2(pts), raw: n, n: t.items.length, max: sumPts(t.items) };
  }
  const isOwner = (t, uid) => t.ownerId === uid;

  /* ===================== ENDPOINTLAR: YARATISH ===================== */
  app.post('/api/tests/create', auth, wrap(async (req, res) => {
    const b = req.body || {}, uid = req.tg.id;
    const type = b.type === 'rasch' ? 'rasch' : b.type === 'simple' ? 'simple' : null;
    if (!type) return fail(res, 400, 'Test turi noto\'g\'ri');
    const title = String(b.title || '').trim().slice(0, 60);
    if (!title) return fail(res, 400, 'Test nomini kiriting.');
    const dur = parseInt(b.durationMin, 10);
    if (!(dur >= DUR_MIN && dur <= DUR_MAX)) return fail(res, 400, `Davomiylik ${DUR_MIN} dan ${DUR_MAX} daqiqagacha bo'lishi kerak.`);

    let parts = null, n = null;
    if (type === 'rasch') { parts = parseParts(b.parts); if (!parts) return fail(res, 400, '41–43-savollar qismlari 2 dan 5 gacha bo\'lishi kerak.'); }
    else { n = parseInt(b.n, 10); if (!SIMPLE_COUNTS.includes(n)) return fail(res, 400, 'Savollar soni 30, 50, 90 yoki 100 bo\'lishi kerak.'); }

    const items = structure(type, { parts, n });
    const errs = [];
    let scoring = null;
    if (type === 'simple') { const r = applyScoring(items, b.scoring); scoring = r.scoring; errs.push(...r.errs); }
    const missing = applyKeys(items, b.keys);
    if (missing.length) errs.push(missingMsg(missing));
    let tol = 0;
    if (type === 'rasch') { tol = parseFloat(String(b.tol == null ? 0 : b.tol).replace(',', '.')); if (!(tol >= 0 && tol <= 100)) tol = 0; }
    if (errs.length) return fail(res, 400, errs.join('\n'));

    const f = b.file;
    if (!f || !f.data) return fail(res, 400, 'Savollar faylini (PDF yoki rasm) yuklang.');
    const mime = String(f.mime || '');
    if (!/^(application\/pdf|image\/(jpeg|png|webp))$/.test(mime)) return fail(res, 400, 'Fayl PDF yoki rasm (JPG, PNG, WEBP) bo\'lishi kerak.');
    const buf = Buffer.from(String(f.data), 'base64');
    if (!buf.length || buf.length > MAX_FILE_BYTES) return fail(res, 400, 'Fayl hajmi 9 MB dan oshmasligi kerak.');

    // Kunlik chegara (avval o'qib tekshiramiz, keyin tranzaksiya bilan band qilamiz)
    const day = tashkentDay();
    const used = (await get(`test_daily/${uid}/${day}`)) || 0;
    if (used >= DAILY_LIMIT) return fail(res, 429, `Kunlik chegaraga yetdingiz (${DAILY_LIMIT} ta test). Ertaga davom eting.`, { code: 'daily_limit' });

    // Savollar faylini yaratuvchining bot chatiga yuboramiz — Telegram uni saqlaydi, file_id ni olamiz
    const id = crypto.randomBytes(6).toString('hex');
    let code = null;
    for (let k = 0; k < 20 && !code; k++) {
      const c = 'T-' + (1000 + crypto.randomInt(9000));
      const tr = await rtdb.ref('tests_by_code/' + c).transaction(v => v ? undefined : id);
      if (tr.committed) code = c;
    }
    if (!code) return fail(res, 500, 'Kod yaratib bo\'lmadi, qayta urinib ko\'ring');
    let tgRes;
    try {
      const fname = String(f.name || 'savollar').replace(/[^\w.\-() ]+/g, '_').slice(0, 60) || 'savollar';
      tgRes = await tgSendDocument(uid, buf, fname, mime, `📄 «${title}» testi savollari\nKod: ${code}`);
      if (!tgRes.ok) throw new Error(tgRes.description || 'sendDocument');
      f.name = fname;
    } catch (e) {
      await rtdb.ref('tests_by_code/' + code).remove();
      console.error('[tests] fayl yuborilmadi:', e.message);
      return fail(res, 502, 'Faylni saqlab bo\'lmadi. Botda /start bosilganini tekshirib, qayta urinib ko\'ring.');
    }
    const fileId = tgRes.result.document.file_id;

    const slot = await rtdb.ref(`test_daily/${uid}/${day}`).transaction(v => { const c = v || 0; return c >= DAILY_LIMIT ? undefined : c + 1; });
    if (!slot.committed) {
      await rtdb.ref('tests_by_code/' + code).remove();
      return fail(res, 429, `Kunlik chegaraga yetdingiz (${DAILY_LIMIT} ta test). Ertaga davom eting.`, { code: 'daily_limit' });
    }

    const test = {
      id, code, type, title, ownerId: uid, ownerName: req.tg.name, durationMin: dur,
      items, status: 'open', createdAt: Date.now(),
      file: { fileId, name: f.name, mime, size: buf.length }
    };
    if (parts) test.parts = parts;
    if (scoring) test.scoring = scoring;
    if (type === 'rasch') test.tol = tol;
    await rtdb.ref('tests/' + id).set(test);
    await rtdb.ref(`tests_by_owner/${uid}/${id}`).set(test.createdAt);
    ok(res, { test: ownerView(test), createdToday: slot.snapshot.val() });
  }));

  app.post('/api/tests/mine', auth, wrap(async (req, res) => {
    const uid = req.tg.id;
    const ids = Object.keys((await get('tests_by_owner/' + uid)) || {});
    const tests = (await Promise.all(ids.map(getTest))).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(t => ({ id: t.id, code: t.code, type: t.type, title: t.title, n: t.items.length, durationMin: t.durationMin, status: t.status, createdAt: t.createdAt }));
    const createdToday = (await get(`test_daily/${uid}/${tashkentDay()}`)) || 0;
    ok(res, { tests, createdToday, dailyLimit: DAILY_LIMIT });
  }));

  app.post('/api/tests/manage', auth, wrap(async (req, res) => {
    const t = await getTest((req.body || {}).testId);
    if (!t || !isOwner(t, req.tg.id)) return fail(res, 404, 'Test topilmadi');
    const attempts = Object.values((await get('attempts/' + t.id)) || {});
    const stats = { started: attempts.length, submitted: attempts.filter(a => a.submittedAt || Date.now() > a.deadline + GRACE_MS).length };
    let results = null;
    if (t.status === 'closed') {
      const r = await get('test_results/' + t.id);
      if (r) { r.people = (r.people || []).map(publicPerson); r.items = r.items || []; results = r; }
    }
    ok(res, { test: ownerView(t), stats, results });
  }));

  app.post('/api/tests/update-key', auth, wrap(async (req, res) => {
    const t = await getTest((req.body || {}).testId);
    if (!t || !isOwner(t, req.tg.id)) return fail(res, 404, 'Test topilmadi');
    if (t.status !== 'open') return fail(res, 409, 'Test yakunlangan, kalitni o\'zgartirib bo\'lmaydi');
    const items = t.items.map(it => Object.assign({}, it));
    const missing = applyKeys(items, (req.body || {}).keys);
    if (missing.length) return fail(res, 400, missingMsg(missing));
    await rtdb.ref('tests/' + t.id + '/items').set(items);
    ok(res);
  }));

  app.post('/api/tests/finish', auth, wrap(async (req, res) => {
    const t = await getTest((req.body || {}).testId);
    if (!t || !isOwner(t, req.tg.id)) return fail(res, 404, 'Test topilmadi');
    if (t.status !== 'open') return fail(res, 409, 'Test allaqachon yakunlangan');
    const now = Date.now();
    const attempts = Object.values((await get('attempts/' + t.id)) || {});
    const pending = attempts.filter(a => !a.submittedAt);           // hali topshirmaganlar — hozir majburan topshirilgan hisoblanadi
    attempts.forEach(a => {
      if (!a.submittedAt) { a.submittedAt = Math.min(now, a.deadline); a.auto = true; }
      a.answers = a.answers || {};
    });
    const need = MIN_PARTICIPANTS[t.type];
    if (attempts.length < need)
      return fail(res, 409, t.type === 'rasch'
        ? `Rasch natijasini hisoblash uchun kamida ${need} ta ishtirokchi kerak (hozir: ${attempts.length}).`
        : `Hali hech kim testni boshlamagan.`, { code: 'few_participants', participants: attempts.length });
    const results = computeResults(t, attempts);
    await Promise.all(pending.map(a => rtdb.ref(`attempts/${t.id}/${a.userId}`).update({ submittedAt: a.submittedAt, auto: true })));
    await rtdb.ref('test_results/' + t.id).set(results);
    await rtdb.ref('tests/' + t.id).update({ status: 'closed', closedAt: now });
    results.people = results.people.map(publicPerson);
    ok(res, { results });
  }));

  app.post('/api/tests/results-pdf', auth, wrap(async (req, res) => {
    const t = await getTest((req.body || {}).testId);
    if (!t || !isOwner(t, req.tg.id)) return fail(res, 404, 'Test topilmadi');
    if (t.status !== 'closed') return fail(res, 409, 'Avval testni yakunlang');
    const results = await get('test_results/' + t.id);
    if (!results) return fail(res, 404, 'Natijalar topilmadi');
    let pdf;
    try { pdf = await buildResultsPdf(t, results); }
    catch (e) { console.error('[tests] PDF:', e.message); return fail(res, 500, 'PDF yaratib bo\'lmadi (pdfkit va dejavu-fonts-ttf o\'rnatilganini tekshiring)'); }
    const r = await tgSendDocument(req.tg.id, pdf, `natijalar_${t.code}.pdf`, 'application/pdf',
      `📊 «${t.title}» — natijalar jadvali (${results.n} ishtirokchi)`);
    if (!r.ok) return fail(res, 502, 'PDF ni botga yuborib bo\'lmadi. Botda /start bosilganini tekshiring.');
    ok(res);
  }));

  /* ===================== ENDPOINTLAR: ISHLASH ===================== */
  app.post('/api/tests/open', auth, wrap(async (req, res) => {
    const code = normCode((req.body || {}).code);
    const id = code ? await get('tests_by_code/' + code) : null;
    const t = id ? await getTest(id) : null;
    if (!t) return fail(res, 404, 'Bunday kodli test topilmadi');
    await rtdb.ref(`test_opened/${req.tg.id}/${t.id}`).set(Date.now());
    const a = await getAttempt(t.id, req.tg.id);
    ok(res, { test: publicView(t), attempt: attemptView(a), serverNow: Date.now() });
  }));

  app.post('/api/tests/get', auth, wrap(async (req, res) => {
    const t = await getTest((req.body || {}).testId);
    if (!t) return fail(res, 404, 'Test topilmadi');
    const a = await getAttempt(t.id, req.tg.id);
    if (!a && !isOwner(t, req.tg.id) && !(await get(`test_opened/${req.tg.id}/${t.id}`))) return fail(res, 404, 'Test topilmadi');
    ok(res, { test: publicView(t), attempt: attemptView(a), serverNow: Date.now() });
  }));

  app.post('/api/tests/opened', auth, wrap(async (req, res) => {
    const uid = req.tg.id;
    const ids = Object.keys((await get('test_opened/' + uid)) || {});
    const rows = await Promise.all(ids.map(async id => {
      const t = await getTest(id);
      if (!t) return null;
      const a = await getAttempt(id, uid);
      const row = { id: t.id, code: t.code, type: t.type, title: t.title, n: t.items.length, durationMin: t.durationMin,
        status: t.status, started: !!a, submitted: !!(a && a.submittedAt), deadline: a ? a.deadline : null };
      if (a && a.submittedAt) {
        if (t.status === 'closed') {
          const r = await get('test_results/' + id);
          const me = r && (r.people || []).find(p => p.userId === uid);
          if (me) { row.pts = me.pts; row.max = r.max; row.ball = me.ball; row.level = me.level || null; }
        } else if (t.type === 'simple') {
          const s = scoreSimple(t, a.answers); row.pts = s.pts; row.max = s.max;
        }
      }
      return row;
    }));
    ok(res, { tests: rows.filter(Boolean), serverNow: Date.now() });
  }));

  app.post('/api/tests/start', auth, wrap(async (req, res) => {
    const t = await getTest((req.body || {}).testId);
    if (!t) return fail(res, 404, 'Test topilmadi');
    if (t.status !== 'open') return fail(res, 409, 'Test yakunlangan');
    const uid = req.tg.id, now = Date.now();
    const att = { userId: uid, name: req.tg.name, username: req.tg.username, startedAt: now, deadline: now + t.durationMin * 60000, answers: {} };
    const tr = await rtdb.ref(`attempts/${t.id}/${uid}`).transaction(v => v ? undefined : att);
    await rtdb.ref(`test_opened/${uid}/${t.id}`).set(now);
    const a = await getAttempt(t.id, uid);
    ok(res, { attempt: attemptView(a), serverNow: Date.now(), created: tr.committed });
  }));

  app.post('/api/tests/save', auth, wrap(async (req, res) => {
    const t = await getTest((req.body || {}).testId);
    if (!t) return fail(res, 404, 'Test topilmadi');
    const a = await getAttempt(t.id, req.tg.id);
    if (!a) return fail(res, 409, 'Test boshlanmagan');
    if (t.status !== 'open' || a.submittedAt) return fail(res, 409, 'Javoblar allaqachon topshirilgan', { code: 'locked' });
    const map = sanitizeAnswers(t, req.body.answers);
    if (Object.keys(map).length) await rtdb.ref(`attempts/${t.id}/${req.tg.id}/answers`).update(map);
    ok(res, { savedAt: Date.now() });
  }));

  app.post('/api/tests/submit', auth, wrap(async (req, res) => {
    const b = req.body || {};
    const t = await getTest(b.testId);
    if (!t) return fail(res, 404, 'Test topilmadi');
    const a = await getAttempt(t.id, req.tg.id);
    if (!a) return fail(res, 409, 'Test boshlanmagan');
    if (a.submittedAt) return ok(res, { attempt: attemptView(a), score: t.type === 'simple' ? scoreSimple(t, a.answers) : null });
    if (t.status !== 'open') return fail(res, 409, 'Test yakunlangan');
    const now = Date.now();
    const answers = Object.assign({}, a.answers, sanitizeAnswers(t, b.answers));
    const late = now > a.deadline + GRACE_MS;
    const auto = !!b.auto || late;
    if (!auto) {
      const missing = t.items.filter(it => !String(answers[it.id] || '').trim()).map(it => it.label);
      if (missing.length) return fail(res, 400, `Hamma savolga javob bermaguncha topshirib bo'lmaydi (${missing.length} ta qoldi).`, { code: 'incomplete', missing });
    }
    const submittedAt = late ? a.deadline : now;
    await rtdb.ref(`attempts/${t.id}/${req.tg.id}`).update({ answers, submittedAt, auto });
    const a2 = await getAttempt(t.id, req.tg.id);
    ok(res, { attempt: attemptView(a2), score: t.type === 'simple' ? scoreSimple(t, a2.answers) : null });
  }));

  app.post('/api/tests/my-result', auth, wrap(async (req, res) => {
    const t = await getTest((req.body || {}).testId);
    if (!t) return fail(res, 404, 'Test topilmadi');
    const uid = req.tg.id;
    const a = await getAttempt(t.id, uid);
    if (!a || !a.submittedAt) return ok(res, { closed: t.status === 'closed', submitted: false });
    if (t.status !== 'closed') {
      return ok(res, t.type === 'simple'
        ? { closed: false, submitted: true, score: scoreSimple(t, a.answers) }
        : { closed: false, submitted: true, waiting: true });
    }
    const r = await get('test_results/' + t.id);
    const list = (r && r.people) || [];
    const idx = list.findIndex(p => p.userId === uid);
    if (idx < 0) return ok(res, { closed: true, submitted: true });
    const me = publicPerson(list[idx]);
    const review = t.items.map(it => ({ id: it.id, key: it.key, ok: isCorrect(it, a.answers[it.id], t.tol) }));
    ok(res, { closed: true, submitted: true, me, rank: idx + 1, n: list.length, max: r.max || null, review });
  }));

  /* ===================== SAVOLLAR FAYLI ===================== */
  const fileSecret = () => crypto.createHmac('sha256', String(BOT_TOKEN)).update('tests-file').digest();
  function signToken(p) {
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    return body + '.' + crypto.createHmac('sha256', fileSecret()).update(body).digest('base64url');
  }
  function readToken(tok) {
    const [body, sig] = String(tok || '').split('.');
    if (!body || !sig) return null;
    const good = crypto.createHmac('sha256', fileSecret()).update(body).digest('base64url');
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
  }
  app.post('/api/tests/file-link', auth, wrap(async (req, res) => {
    const t = await getTest((req.body || {}).testId);
    if (!t || !t.file) return fail(res, 404, 'Fayl topilmadi');
    const uid = req.tg.id;
    const a = await get(`attempts/${t.id}/${uid}`);
    if (!a && !isOwner(t, uid)) return fail(res, 403, 'Avval testni boshlang');
    const token = signToken({ tid: t.id, uid, exp: Date.now() + 10 * 60 * 1000 });
    ok(res, { url: `/api/tests/file/${token}`, mime: t.file.mime, name: t.file.name });
  }));
  app.get('/api/tests/file/:token', wrap(async (req, res) => {
    const p = readToken(req.params.token);
    if (!p) return res.status(403).send('Havola eskirgan');
    const t = await getTest(p.tid);
    if (!t || !t.file) return res.status(404).send('Fayl topilmadi');
    const buf = await tgGetFile(t.file.fileId);
    if (!buf) return res.status(502).send('Faylni olib bo\'lmadi');
    res.set('Content-Type', t.file.mime);
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(t.file.name)}`);
    res.set('Cache-Control', 'private, max-age=600');
    res.send(buf);
  }));

  /* ===================== PDF ===================== */
  function buildResultsPdf(t, r) {
    const PDFDocument = require('pdfkit');
    let font = null;
    try { font = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'); } catch (e) { /* Helvetica'ga tushamiz */ }
    const clean = s => String(s == null ? '' : s).replace(/[\u{10000}-\u{10FFFF}\uFE0F\u200D]/gu, '').trim();
    const fmt = s => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: t.title + ' — natijalar' } });
      const chunks = [];
      doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      if (font) doc.font(font);
      const rasch = t.type === 'rasch';
      const cols = rasch
        ? [['№', 28, 'r'], ['Ishtirokchi', 190, 'l'], ["To'g'ri", 50, 'r'], ['Logit', 46, 'r'], ['Ball', 46, 'r'], ['Daraja', 46, 'l'], ['Vaqt', 56, 'r']]
        : [['№', 28, 'r'], ['Ishtirokchi', 200, 'l'], ["To'g'ri", 56, 'r'], ['Ball', 56, 'r'], ['Foiz', 50, 'r'], ['Vaqt', 60, 'r']];
      const total = cols.reduce((a, c) => a + c[1], 0);
      doc.fontSize(15).text(clean(t.title) + ' — natijalar jadvali');
      doc.moveDown(0.2).fontSize(9).fillColor('#475569').text(
        `Sana: ${new Date().toLocaleDateString('uz-UZ')} · Ishtirokchilar: ${r.n} · ` + (t.type === 'rasch' ? `Javob maydonlari: ${t.items.length} (43 savol)` : `Savollar: ${t.items.length}`) +
        (rasch ? ' · Hisoblash: Rasch modeli (JMLE)' : ` · Maksimal ball: ${r.max}`) + ' · Kod: ' + t.code);
      if (rasch) doc.text('Daraja chegaralari: ' + LEVELS.map(([m, n]) => `${n} ≥ ${m}`).join(', '));
      doc.moveDown(0.6).fillColor('#0f172a');
      const rowH = 18;
      const head = () => {
        let x = 36; const y = doc.y;
        doc.rect(36, y - 3, total, rowH).fill('#f1f5f9').fillColor('#0f172a').fontSize(9);
        cols.forEach(([h, w, al]) => { doc.text(h, x + 3, y, { width: w - 6, align: al === 'r' ? 'right' : 'left', lineBreak: false }); x += w; });
        doc.y = y + rowH;
      };
      head();
      (r.people || []).forEach((p, i) => {
        if (doc.y > doc.page.height - 60) { doc.addPage(); head(); }
        const y = doc.y; let x = 36;
        const who = clean(p.name) + (p.username ? ' @' + p.username : '');
        const cells = rasch
          ? [i + 1, who, `${p.raw}/${t.items.length}`, (p.theta >= 0 ? '+' : '') + p.theta, p.ball, p.level || '—', fmt(p.time)]
          : [i + 1, who, `${p.raw}/${t.items.length}`, p.pts, Math.round(p.pts / r.max * 100) + '%', fmt(p.time)];
        doc.fontSize(9);
        cells.forEach((c, k) => { doc.text(String(c), x + 3, y, { width: cols[k][1] - 6, align: cols[k][2] === 'r' ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += cols[k][1]; });
        doc.moveTo(36, y + rowH - 4).lineTo(36 + total, y + rowH - 4).lineWidth(0.3).strokeColor('#e2e8f0').stroke();
        doc.y = y + rowH;
      });
      doc.end();
    });
  }

  /* ===================== MINI APP SAHIFASI ===================== */
  app.get('/tests', (req, res) => res.sendFile(path.join(__dirname, 'tests.html')));

  // Ixtiyoriy: botning menyu tugmasini "Testlar"ga o'zgartirish (TESTS_MENU_BUTTON=1 va PUBLIC_URL berilganda).
  // DIQQAT: bu botning hozirgi menyu tugmasini (agar asosiy Mini App'ga ulangan bo'lsa) almashtiradi.
  if (process.env.TESTS_MENU_BUTTON === '1' && process.env.PUBLIC_URL && BOT_TOKEN) {
    fetch(`${TG_API}/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'web_app', text: '📝 Testlar', web_app: { url: process.env.PUBLIC_URL.replace(/\/$/, '') + '/tests' } } })
    }).then(r => r.json()).then(j => console.log('Testlar menyu tugmasi:', j.ok ? 'o\'rnatildi' : j.description))
      .catch(e => console.error('Menyu tugmasi o\'rnatilmadi:', e.message));
  }

  console.log('Testlar moduli ulandi (/tests, /api/tests/*).');
};
