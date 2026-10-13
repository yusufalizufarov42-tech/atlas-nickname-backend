// ============================================================================
//  UY VAZIFASI va USTOZ ASBOBLARI moduli
//   • Uy vazifasi / sinf olimpiadasi (faqat shu sinf uchun yopiq): ustoz mavzu(lar), savollar soni va muddat belgilaydi;
//     kim bajargani/bajarmagani ko'rinadi; bot muddatdan 1 kun va 3 soat oldin eslatadi.
//   • Haftalik sinf reytingi, sinf umumiy streaki, yutuq nishonlari, maktablar (muassasalar) reytingi.
//   • Ustoz uchun: haftalik hisobot botda (yakshanba 20:30), sinf natijalari CSV (Excel'da ochiladi) botga yuboriladi.
//   • Ota-ona uchun ixtiyoriy haftalik hisobot — FAQAT o'quvchi o'zi kod yaratib bergan taqdirda (yakshanba 20:15).
//
//  server.js:  require('./uyvazifa')(app, { rtdb, loadDB, BOT_TOKEN, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY });
//
//  RTDB: hw/{KOD}/{id} {id,title,type:'hw'|'olimp',topics[],count,startAt,dueAt,createdAt,reminded{d1,h3}}
//        hw_sub/{KOD}/{id}/{uid} {correct,total,at,late,tries}
//        parent_codes/{kod} -> uid · users/{id}.parents/{parentId} · users/{id}.streak {d,n,best}
//        meta/cstreak/lastDay · meta/pweekly/lastMon · meta/tweekly/lastMon
// ============================================================================
'use strict';

module.exports = function mountHomework(app, deps) {
  const H = require('./ortak')(app, deps);
  const { rtdb, checkInternalKey, INTERNAL_API_KEY } = deps;
  const err = H.fail;
  let topics = {}; try { topics = require('./topics.json'); } catch (e) { /* ixtiyoriy */ }
  const TOPIC_RE = /^\d{1,2}_\d{1,2}$/;
  const HOUR = 3600 * 1000, DAY = 24 * HOUR;
  const topicName = k => topics[k] || k;
  const pct = (c, t) => (t ? Math.round(100 * c / t) : null);
  const weekOf = (e, mon) => (e && e.week && e.week.m === mon ? e.week : { t: 0, c: 0 });
  const teacherOwns = async (uid, code) => { const c = await H.cls(code); return c && String(c.teacherId) === String(uid) ? c : null; };

  // ------------------------------------------------------------------ UY VAZIFASI
  app.post('/api/hw/create', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const b = req.body || {}, code = H.cleanCode(b.code), c = await teacherOwns(uid, code);
    if (!c) return err(res, 403, 'Faqat sinf ustozi vazifa bera oladi');
    if (await H.blocked(uid)) return err(res, 403, 'Sizning hisobingiz cheklangan');
    const type = b.type === 'olimp' ? 'olimp' : 'hw';
    const tps = (Array.isArray(b.topics) ? b.topics : []).map(String).filter(k => TOPIC_RE.test(k)).slice(0, 8);
    if (!tps.length) return err(res, 400, 'Kamida bitta mavzu tanlang');
    const count = Math.round(Number(b.count));
    if (!(count >= 5 && count <= (type === 'olimp' ? 45 : 30))) return err(res, 400, `Savollar soni 5 dan ${type === 'olimp' ? 45 : 30} gacha bo'lsin`);
    const now = Date.now(), dueAt = Number(b.dueAt), startAt = type === 'olimp' && Number(b.startAt) > now ? Number(b.startAt) : now;
    if (!(dueAt >= now + 10 * 60000 && dueAt <= now + 60 * DAY)) return err(res, 400, "Muddat hozirdan kamida 10 daqiqa keyin va 60 kundan oshmasin");
    if (startAt >= dueAt) return err(res, 400, "Boshlanish vaqti muddatdan oldin bo'lsin");
    const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 60) || (type === 'olimp' ? 'Sinf olimpiadasi' : 'Uy vazifasi');
    if (Object.keys((await H.get('hw/' + code)) || {}).length >= 40) return err(res, 400, "Juda ko'p vazifa — eskilarini o'chiring");
    if (app.locals.chatFilters && (await app.locals.chatFilters.hasBadWord(title))) return err(res, 400, "Sarlavhada nomaqbul so'z bor");
    const ref = rtdb.ref('hw/' + code).push(), id = ref.key;
    await ref.set({ id, title, type, topics: tps, count, startAt, dueAt, createdAt: now });
    const names = tps.slice(0, 3).map(topicName).join(', ') + (tps.length > 3 ? '…' : '');
    const text = type === 'olimp'
      ? `🏆 Sinf olimpiadasi: «${title}»\n${count} savol · ${names}\nBoshlanishi: ${H.fmtDate(startAt)} · tugashi: ${H.fmtDate(dueAt)}\nFaqat bir urinish!`
      : `📋 Yangi uy vazifasi: «${title}»\n${count} savol · ${names}\nMuddat: ${H.fmtDate(dueAt)}`;
    await H.addMsg(code, uid, text, 'announce', { system: true });
    H.members(code).then(ids => H.notifyMany(ids, text, { code, btn: type === 'olimp' ? '🏆 Ochish' : '📋 Bajarish', qs: '?vazifa=' + code })).catch(() => {});
    res.json({ success: true, id });
  });

  app.get('/api/hw/list', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const code = H.cleanCode(req.query.code), a = await H.access(code, uid);
    if (a.error) return err(res, a.error[0], a.error[1]);
    const [all, subs, members] = await Promise.all([H.get('hw/' + code), H.get('hw_sub/' + code), H.members(code)]);
    const now = Date.now();
    const items = Object.values(all || {}).sort((x, y) => y.dueAt - x.dueAt).map(h => {
      const s = (subs || {})[h.id] || {};
      const o = { id: h.id, title: h.title, type: h.type, topics: h.topics, topicNames: h.topics.map(topicName), count: h.count, startAt: h.startAt, dueAt: h.dueAt, started: now >= h.startAt, closed: now > h.dueAt };
      if (a.isTeacher) { o.done = Object.keys(s).length; o.total = members.length; } else o.mine = s[uid] || null;
      return o;
    });
    res.json({ success: true, isTeacher: a.isTeacher, items, now });
  });

  app.get('/api/hw/detail', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const code = H.cleanCode(req.query.code), id = String(req.query.id || '').replace(/[.#$/\[\]]/g, ''), a = await H.access(code, uid);
    if (a.error) return err(res, a.error[0], a.error[1]);
    const h = await H.get(`hw/${code}/${id}`);
    if (!h) return err(res, 404, 'Vazifa topilmadi');
    const now = Date.now(), olimpOpen = h.type === 'olimp' && now > h.dueAt;
    if (!a.isTeacher && !olimpOpen) return err(res, 403, "Natijalarni faqat ustoz ko'ra oladi");
    const [subs, members, db] = await Promise.all([H.get(`hw_sub/${code}/${id}`), H.members(code), H.users()]);
    const rows = members.map(m => { const s = (subs || {})[m]; return { name: H.dname(db[m]), done: !!s, correct: s ? s.correct : 0, total: s ? s.total : h.count, late: !!(s && s.late), at: s ? s.at : null, isMe: m === uid }; })
      .sort((x, y) => (y.done - x.done) || (y.correct - x.correct) || ((x.at || 0) - (y.at || 0)) || x.name.localeCompare(y.name));
    res.json({ success: true, title: h.title, type: h.type, count: h.count, dueAt: h.dueAt, done: rows.filter(r => r.done).length, total: rows.length, rows: a.isTeacher ? rows : rows.filter(r => r.done).slice(0, 30) });
  });

  app.post('/api/hw/submit', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const b = req.body || {}, code = H.cleanCode(b.code), id = String(b.hwId || '').replace(/[.#$/\[\]]/g, ''), a = await H.access(code, uid);
    if (a.error) return err(res, a.error[0], a.error[1]);
    if (a.isTeacher) return err(res, 400, 'Ustoz vazifa topshirmaydi');
    const h = await H.get(`hw/${code}/${id}`);
    if (!h) return err(res, 404, 'Vazifa topilmadi');
    const now = Date.now(), total = Math.round(Number(b.total)), correct = Math.round(Number(b.correct));
    if (now < h.startAt) return err(res, 400, 'Bu vazifa hali boshlanmagan');
    if (!(total >= 1 && total <= h.count) || !(correct >= 0 && correct <= total)) return err(res, 400, "Natija noto'g'ri");
    const late = now > h.dueAt;
    if (h.type === 'olimp' && late) return err(res, 400, 'Olimpiada tugagan');
    const ref = rtdb.ref(`hw_sub/${code}/${id}/${uid}`);
    let first = false, rejected = false;
    const tx = await ref.transaction(cur => {
      if (!cur) { first = true; return { correct, total, at: now, late, tries: 1 }; }
      if (h.type === 'olimp') { rejected = true; return; }                   // olimpiadada bitta urinish
      const better = correct / total > cur.correct / cur.total;
      return { correct: better ? correct : cur.correct, total: better ? total : cur.total, at: better ? now : cur.at, late: better ? late : cur.late, tries: (cur.tries || 1) + 1 };
    });
    if (rejected || !tx.committed) return err(res, 400, "Olimpiadada faqat bir marta qatnashish mumkin");
    if (app.locals.bumpWeek) await app.locals.bumpWeek(uid, correct, total);       // haftalik reyting/hisobot uchun
    if (h.topics.length === 1) await rtdb.ref(`users/${uid}/topicStats/${h.topics[0]}`).transaction(c => ({ correct: ((c && c.correct) || 0) + correct, total: ((c && c.total) || 0) + total }));
    if (first) await rtdb.ref(`users/${uid}/hwDone`).transaction(c => (c || 0) + 1);
    res.json({ success: true, first, late, olimp: h.type === 'olimp' });
  });

  app.post('/api/hw/delete', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const b = req.body || {}, code = H.cleanCode(b.code), id = String(b.id || '').replace(/[.#$/\[\]]/g, '');
    if (!(await teacherOwns(uid, code))) return err(res, 403, "Ruxsat yo'q");
    await rtdb.ref(`hw/${code}/${id}`).remove(); await rtdb.ref(`hw_sub/${code}/${id}`).remove();
    res.json({ success: true });
  });

  // ------------------------------------------------------------------ MUDDAT ESLATMASI (har 5 daqiqada)
  async function remind() {
    if (H.quiet()) return;
    const all = (await H.get('hw')) || {}, now = Date.now();
    for (const code of Object.keys(all)) for (const h of Object.values(all[code] || {})) {
      const left = h.dueAt - now;
      if (left <= 0 || left > DAY) continue;
      const stage = left <= 3 * HOUR ? 'h3' : 'd1';
      if (((h.reminded || {})[stage])) continue;
      const tx = await rtdb.ref(`hw/${code}/${h.id}/reminded/${stage}`).transaction(c => (c ? undefined : true));
      if (!tx.committed) continue;
      const [subs, members] = await Promise.all([H.get(`hw_sub/${code}/${h.id}`), H.members(code)]);
      const todo = members.filter(u => !(subs || {})[u]);
      await H.notifyMany(todo, `⏰ «${h.title}» — muddatga ${stage === 'h3' ? '3 soatdan kam' : '1 kun'} qoldi (${H.fmtDate(h.dueAt)}). Hali bajarmagansiz!`, { code, btn: '📋 Bajarish', qs: '?vazifa=' + code });
    }
  }

  // ------------------------------------------------------------------ SINF REYTINGI (haftalik)
  app.get('/api/class/rank', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const code = H.cleanCode(req.query.code), a = await H.access(code, uid);
    if (a.error) return err(res, a.error[0], a.error[1]);
    const ids = await H.members(code), db = await H.users(true), mon = H.mondayOf();
    const rows = ids.map(id => { const w = weekOf(db[id], mon); return { name: H.dname(db[id]), weekTotal: w.t, weekCorrect: w.c, acc: pct(w.c, w.t), streak: (db[id] && db[id].streak && db[id].streak.n) || 0, isMe: id === uid }; })
      .sort((x, y) => (y.weekCorrect - x.weekCorrect) || ((y.acc || 0) - (x.acc || 0)) || x.name.localeCompare(y.name));
    res.json({ success: true, name: a.c.name, items: rows.slice(0, 30), classStreak: a.c.cstreak ? a.c.cstreak.n : 0, count: ids.length });
  });

  // ------------------------------------------------------------------ YUTUQ NISHONLARI
  const BADGES = [
    { id: 'first', e: '🌱', n: 'Birinchi qadam', d: '1 ta savol yeching', f: s => s.total, goal: 1 },
    { id: 'q100', e: '💯', n: '100 ta savol', d: '100 ta savol yeching', f: s => s.total, goal: 100 },
    { id: 'q500', e: '🚀', n: '500 ta savol', d: '500 ta savol yeching', f: s => s.total, goal: 500 },
    { id: 'q1000', e: '🏅', n: '1000 ta savol', d: '1000 ta savol yeching', f: s => s.total, goal: 1000 },
    { id: 'acc', e: '🎯', n: 'Aniq nishon', d: '50+ savolda 90% aniqlik', f: s => (s.total >= 50 ? s.acc : 0), goal: 90 },
    { id: 'st7', e: '🔥', n: '7 kun ketma-ket', d: "7 kun ketma-ket kiring", f: s => s.best, goal: 7 },
    { id: 'st30', e: '⚡', n: '30 kun ketma-ket', d: "30 kun ketma-ket kiring", f: s => s.best, goal: 30 },
    { id: 'hw1', e: '📋', n: 'Mas’uliyatli', d: 'Birinchi uy vazifasini bajaring', f: s => s.hw, goal: 1 },
    { id: 'hw10', e: '📚', n: 'Vazifa ustasi', d: '10 ta uy vazifasi bajaring', f: s => s.hw, goal: 10 },
  ];
  app.get('/api/badges', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const e = (await H.get('users/' + uid)) || {};
    let t = 0, c = 0; Object.values(e.topicStats || {}).forEach(s => { t += s.total || 0; c += s.correct || 0; });
    const s = { total: t, acc: pct(c, t) || 0, best: (e.streak && Math.max(e.streak.best || 0, e.streak.n || 0)) || 0, hw: e.hwDone || 0 };
    res.json({ success: true, stats: { total: t, acc: pct(c, t), streak: (e.streak && e.streak.n) || 0, bestStreak: s.best, hwDone: s.hw },
      badges: BADGES.map(b => { const v = b.f(s); return { id: b.id, emoji: b.e, name: b.n, desc: b.d, got: v >= b.goal, progress: Math.min(v, b.goal), goal: b.goal }; }) });
  });

  // ------------------------------------------------------------------ SINF UMUMIY STREAKI (har kuni 23:30 dan keyin hisoblanadi)
  async function classStreaks() {
    const m = H.tashMin();
    if (m < 23 * 60 + 30) return;
    const today = H.tashDay();
    const tx = await rtdb.ref('meta/cstreak/lastDay').transaction(c => (c === today ? undefined : today));
    if (!tx.committed) return;
    const [classes, mem, db] = await Promise.all([H.get('classes'), H.get('class_members'), H.users(true)]);
    const yest = H.tashDay(Date.now() - DAY);
    for (const c of Object.values(classes || {})) {
      const ids = Object.keys((mem || {})[c.code] || {});
      if (ids.length < 3) continue;
      const active = ids.filter(id => db[id] && db[id].lastSeenAt && H.tashDay(Date.parse(db[id].lastSeenAt)) === today).length;
      const prev = c.cstreak || { d: '', n: 0 };
      const n = active / ids.length >= 0.5 ? (prev.d === yest ? prev.n + 1 : 1) : 0;
      await rtdb.ref(`classes/${c.code}/cstreak`).set({ d: today, n });
    }
  }

  // ------------------------------------------------------------------ MAKTABLAR (MUASSASALAR) REYTINGI
  app.get('/api/inst/rating', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const scope = ['district', 'region'].includes(req.query.scope) ? req.query.scope : 'all';
    const [db, insts] = await Promise.all([H.users(true), H.get('institutions')]);
    const me = db[uid] || {}, mon = H.mondayOf(), agg = {};
    Object.keys(db).forEach(k => {
      const e = db[k]; if (!e || !e.instId || e.isAdmin || e.blocked || !insts || !insts[e.instId]) return;
      const i = insts[e.instId];
      if (scope === 'district' && !(me.region && i.region === me.region && i.district === me.district)) return;
      if (scope === 'region' && !(me.region && i.region === me.region)) return;
      const w = weekOf(e, mon), a = agg[e.instId] = agg[e.instId] || { id: e.instId, name: i.name, type: i.type, members: 0, weekCorrect: 0, weekTotal: 0 };
      a.members++; a.weekCorrect += w.c; a.weekTotal += w.t;
    });
    const ranked = Object.values(agg).filter(a => a.members >= 2).sort((x, y) => (y.weekCorrect - x.weekCorrect) || (y.members - x.members) || x.name.localeCompare(y.name));
    const myIdx = ranked.findIndex(a => a.id === me.instId);
    res.json({ success: true, scope, items: ranked.slice(0, 20).map((a, i) => ({ rank: i + 1, name: a.name, type: a.type, members: a.members, weekCorrect: a.weekCorrect, acc: pct(a.weekCorrect, a.weekTotal), mine: a.id === me.instId })),
      mine: myIdx >= 0 ? { rank: myIdx + 1, name: ranked[myIdx].name, of: ranked.length } : null, myInst: me.instName || null });
  });

  // ------------------------------------------------------------------ CSV (Excel'da ochiladi) — botga yuboriladi
  const csvCell = v => { const s = String(v == null ? '' : v); return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  async function classCsv(code, c) {
    const ids = await H.members(code), db = await H.users(true), mon = H.mondayOf();
    const [hws, subs] = await Promise.all([H.get('hw/' + code), H.get('hw_sub/' + code)]);
    const hwIds = Object.keys(hws || {}).filter(id => (hws[id].type || 'hw') === 'hw');
    const head = ['Taxallus / ism', 'Shu hafta: savol', "Shu hafta: to'g'ri", 'Shu hafta: aniqlik %', 'Jami savol', 'Jami aniqlik %', 'Atom', 'Zaif mavzu', 'Uy vazifasi: bajarilgan', 'Uy vazifasi: jami'];
    const rows = ids.map(id => {
      const e = db[id] || {}, w = weekOf(e, mon); let t = 0, cc = 0, weak = null;
      for (const k in (e.topicStats || {})) { const s = e.topicStats[k]; t += s.total; cc += s.correct; if (s.total >= 3) { const p = Math.round(100 * s.correct / s.total); if (p < 70 && (!weak || p < weak.p)) weak = { p, n: topicName(k) }; } }
      const done = hwIds.filter(h => ((subs || {})[h] || {})[id]).length;
      return [H.dname(e), w.t, w.c, pct(w.c, w.t) == null ? '' : pct(w.c, w.t), t, pct(cc, t) == null ? '' : pct(cc, t), e.atoms || 0, weak ? `${weak.n} (${weak.p}%)` : '', done, hwIds.length];
    });
    return '﻿' + [head].concat(rows).map(r => r.map(csvCell).join(';')).join('\r\n');
  }
  app.post('/api/class/export-send', async (req, res) => {             // Mini App'dan (initData) yoki botdan (X-Internal-Key + userId)
    let uid = H.authUid(req);
    if (!uid && INTERNAL_API_KEY && req.headers['x-internal-key'] === INTERNAL_API_KEY && H.uidOk((req.body || {}).userId)) uid = String(req.body.userId);
    if (!uid) return err(res, 401, 'Telegram ichida oching');
    const code = H.cleanCode((req.body || {}).code), c = await teacherOwns(uid, code);
    if (!c) return err(res, 403, 'Faqat sinf ustozi yuklab oladi');
    const csv = await classCsv(code, c);
    const r = await H.sendDoc(uid, `sinf_${code}_${H.tashDay()}.csv`, Buffer.from(csv, 'utf8'), `📊 «${c.name}» — sinf natijalari. Excel yoki Google Sheets'da oching.`);
    if (!r.ok) return err(res, 502, "Faylni yuborib bo'lmadi. Avval botga /start bosganingizni tekshiring.");
    res.json({ success: true });
  });
  app.post('/api/bot/classes', async (req, res) => {                   // bot: ustozning sinflari ro'yxati
    if (!INTERNAL_API_KEY) return err(res, 503, 'INTERNAL_API_KEY sozlanmagan');
    if (!checkInternalKey(req, res)) return;
    const uid = String((req.body || {}).userId || '');
    const all = (await H.get('classes')) || {}, mem = (await H.get('class_members')) || {};
    res.json({ success: true, items: Object.values(all).filter(c => String(c.teacherId) === uid).map(c => ({ code: c.code, name: c.name, count: Object.keys(mem[c.code] || {}).length })) });
  });

  // ------------------------------------------------------------------ OTA-ONA HISOBOTI (faqat o'quvchi roziligi bilan)
  const parentLink = code => `https://t.me/${H.BOT_USERNAME}?start=ota_${code}`;
  app.post('/api/parent/code', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    let code = await H.get(`users/${uid}/parentCode`);
    if (!code) {
      for (let i = 0; i < 6 && !code; i++) { const k = H.rnd(8); const tx = await rtdb.ref('parent_codes/' + k).transaction(c => (c ? undefined : uid)); if (tx.committed) code = k; }
      if (!code) return err(res, 500, "Kod yaratib bo'lmadi");
      await rtdb.ref(`users/${uid}/parentCode`).set(code);
    }
    res.json({ success: true, code, link: parentLink(code) });
  });
  app.get('/api/parent/status', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const e = (await H.get('users/' + uid)) || {};
    res.json({ success: true, code: e.parentCode || null, link: e.parentCode ? parentLink(e.parentCode) : null, count: Object.keys(e.parents || {}).length });
  });
  app.post('/api/parent/revoke', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const code = await H.get(`users/${uid}/parentCode`);
    if (code) await rtdb.ref('parent_codes/' + code).remove();
    await rtdb.ref(`users/${uid}/parentCode`).remove(); await rtdb.ref(`users/${uid}/parents`).remove();
    res.json({ success: true });
  });
  app.post('/api/parent/link', async (req, res) => {                   // bot: ota-ona havolani ochganda
    if (!INTERNAL_API_KEY) return err(res, 503, 'INTERNAL_API_KEY sozlanmagan');
    if (!checkInternalKey(req, res)) return;
    const code = String((req.body || {}).code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10), pid = String((req.body || {}).parentId || '');
    const uid = code ? await H.get('parent_codes/' + code) : null;
    if (!uid || !H.uidOk(pid)) return err(res, 404, 'Havola eskirgan yoki noto\'g\'ri');
    const e = (await H.get('users/' + uid)) || {};
    if (Object.keys(e.parents || {}).length >= 3 && !(e.parents || {})[pid]) return err(res, 400, "Bitta o'quvchiga 3 tadan ko'p ota-ona ulab bo'lmaydi");
    await rtdb.ref(`users/${uid}/parents/${pid}`).set(Date.now());
    H.notify(uid, "👨‍👩‍👧 Ota-onangiz haftalik hisobotni olish uchun ulandi. Istalgan payt Mini App → Sinf bo'limidan o'chira olasiz.", { noButton: true }).catch(() => {});
    res.json({ success: true, childName: H.dname(e) });
  });

  // ------------------------------------------------------------------ HAFTALIK HISOBOTLAR (yakshanba)
  async function parentWeekly() {
    const db = await H.users(true), mon = H.mondayOf();
    for (const uid of Object.keys(db)) {
      const e = db[uid]; if (!e || !e.parents) continue;
      const w = weekOf(e, mon); let weak = null;
      Object.entries(e.topicStats || {}).filter(([, s]) => s.total >= 3).forEach(([k, s]) => { const p = Math.round(100 * s.correct / s.total); if (p < 70 && (!weak || p < weak.p)) weak = { p, n: topicName(k) }; });
      const text = `👨‍👩‍👧 ${H.dname(e)} — haftalik hisobot\n\n` + (w.t ? `✅ Yechilgan savollar: ${w.t}\n🎯 Aniqlik: ${pct(w.c, w.t)}%\n` : "Bu hafta mashq qilmadi.\n") + (weak ? `⚠️ Mustahkamlash kerak: ${weak.n} (${weak.p}%)\n` : '') + '\nBu xabarni o\'quvchi o\'zi ulagan. To\'xtatish: Mini App → Sinf.';
      for (const pid of Object.keys(e.parents)) { await H.notify(pid, text, { noButton: true, force: true }); await H.sleep(40); }
    }
  }
  async function teacherWeekly() {
    const [classes, mem, db, hws, subs] = await Promise.all([H.get('classes'), H.get('class_members'), H.users(true), H.get('hw'), H.get('hw_sub')]);
    const mon = H.mondayOf(), now = Date.now();
    for (const c of Object.values(classes || {})) {
      const ids = Object.keys((mem || {})[c.code] || {});
      if (!ids.length) continue;
      const rows = ids.map(id => ({ name: H.dname(db[id]), w: weekOf(db[id], mon), e: db[id] || {} }));
      const active = rows.filter(r => r.w.t > 0), T = active.reduce((a, r) => a + r.w.t, 0), C = active.reduce((a, r) => a + r.w.c, 0);
      const top = active.sort((x, y) => y.w.c - x.w.c).slice(0, 3).map(r => `${r.name} (${r.w.c})`).join(', ');
      const agg = {}; rows.forEach(r => Object.entries(r.e.topicStats || {}).forEach(([k, s]) => { const a = agg[k] = agg[k] || { t: 0, c: 0 }; a.t += s.total; a.c += s.correct; }));
      const weak = Object.entries(agg).filter(([, a]) => a.t >= 5).map(([k, a]) => ({ n: topicName(k), p: Math.round(100 * a.c / a.t) })).filter(x => x.p < 70).sort((x, y) => x.p - y.p).slice(0, 2);
      const late = Object.values((hws || {})[c.code] || {}).filter(h => h.type !== 'olimp' && h.dueAt < now && h.dueAt > now - 7 * DAY).map(h => ({ t: h.title, miss: ids.length - Object.keys(((subs || {})[c.code] || {})[h.id] || {}).length })).filter(x => x.miss > 0).slice(0, 3);
      const text = `📊 «${c.name}» — haftalik hisobot\n\n👥 Faol: ${active.length}/${ids.length}\n🎯 O'rtacha aniqlik: ${C || T ? pct(C, T) + '%' : '—'}\n` + (top ? `🏆 Eng faollar: ${top}\n` : '') + (weak.length ? `⚠️ Xato ko'p mavzular: ${weak.map(x => `${x.n} (${x.p}%)`).join(', ')}\n` : '') + (late.length ? `📋 Bajarilmagan vazifalar: ${late.map(x => `${x.t} (${x.miss} kishi)`).join(', ')}\n` : '') + '\nBatafsil va Excel (CSV): Mini App → Sinf.';
      await H.notify(c.teacherId, text, { open: 'class', btn: '🎓 Sinflarim' });
      await H.sleep(40);
    }
  }
  async function weeklyTick() {
    if (!H.isSunday()) return;
    const m = H.tashMin(), mon = H.mondayOf();
    if (m >= 20 * 60 + 15 && m < 23 * 60) {
      const tx = await rtdb.ref('meta/pweekly/lastMon').transaction(c => (c === mon ? undefined : mon));
      if (tx.committed) await parentWeekly();
    }
    if (m >= 20 * 60 + 30 && m < 23 * 60) {
      const tx = await rtdb.ref('meta/tweekly/lastMon').transaction(c => (c === mon ? undefined : mon));
      if (tx.committed) await teacherWeekly();
    }
  }

  let busy = false;
  async function tick() {
    if (busy || !rtdb) return; busy = true;
    try { await remind(); await classStreaks(); await weeklyTick(); } catch (e) { console.error('[uyvazifa] tick', e && e.message); } finally { busy = false; }
  }
  if (rtdb) { const t = setInterval(tick, 5 * 60 * 1000); if (t.unref) t.unref(); }
  module.exports.__internal = { remind, classStreaks, parentWeekly, teacherWeekly, classCsv, BADGES };
  app.locals.hwInternal = { remind, classStreaks, parentWeekly, teacherWeekly };
};
