// ============================================================================
//  GURUH moduli — ustoz qidirish, qo'shilish so'rovi, sinf guruh chati, e'lonlar, shikoyat va moderatsiya.
//  server.js:  require('./guruh')(app, { rtdb, loadDB, BOT_TOKEN, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY });
//
//  XAVFSIZLIK QOIDALARI (bolalar bilan ishlaganimiz uchun):
//   • Shaxsiy yozishma YO'Q — faqat sinf guruhi (a'zolar + ustoz).
//   • Hamma faqat taxallus yoki Telegram ismi bilan ko'rinadi (to'liq ism, telefon hech kimga ko'rinmaydi).
//   • Chatda telefon raqam, @username, t.me havolalari taqiqlangan (aloqani platformadan tashqariga olib chiqmaslik uchun).
//     Havolalarni faqat ADMIN TASDIQLAGAN ustoz yoza oladi.
//   • Haqoratli/odobsiz so'zlar filtri (admin ro'yxatni settings/badwords orqali kengaytira oladi).
//   • Tezlik chegarasi: 2,5 soniyada 1 xabar, daqiqada 15 tagacha; bir xil xabarni qayta yuborib bo'lmaydi.
//   • "Faqat e'lonlar" rejimi: ustoz suhbatni yopib qo'yishi mumkin.
//   • Har xabarda 🚩 Shikoyat: 3 ta turli shikoyatdan keyin xabar admin ko'rib chiqquncha avtomatik yashiriladi.
//   • Admin: /shikoyatlar (xabarni o'chirish / foydalanuvchini bloklash / rad etish), /tasdiq (ustozni tasdiqlash).
//   • Bildirishnomalar jim soatlarda (22:00–07:00) yuborilmaydi.
//
//  RTDB: class_msgs/{KOD}/{id} {id, uid, text, kind: chat|announce, at, system?, hidden?}
//        reports/{id} {id, code, className, msgId, targetUid, targetName, text, reporterId, reason, at, status}
//        msg_reports/{msgId} -> son · class_declined/{KOD}/{uid} -> vaqt · users/{id}.blocked / .verifiedTeacher / .hiddenTeacher
// ============================================================================
'use strict';

module.exports = function mountGroups(app, deps) {
  const H = require('./ortak')(app, deps);
  const { rtdb, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY } = deps;
  const err = H.fail;
  let topics = {}; try { topics = require('./topics.json'); } catch (e) { /* ixtiyoriy */ }
  const MAX_PENDING = 5, MSG_MAX = 500, SHOW = 60;

  // ------------------------------------------------------------------ MATN FILTRLARI
  const BAD_STEMS = ['sikaman', 'siktir', 'sikish', 'sikay', 'qotoq', 'kotak', 'jalab', 'jalap', 'dalbayob', 'blyad', 'blyat', 'bliat', 'pizd', 'ebat', 'ebal', 'yebat',
    'mudak', 'gandon', 'pidor', 'pidar', 'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigg', 'whore', 'slut', 'ahmoq', 'axmoq', 'tentak', 'ablah',
    'бля', 'хуй', 'хуя', 'хуе', 'пизд', 'ебан', 'ебат', 'сука', 'мудак', 'пидор', 'гандон', 'дебил', 'идиот'];
  const BAD_EXACT = ['sik', 'lox', 'loh', 'suka', 'xuy', 'huy', 'hui', 'xui', 'dick', 'лох', 'сик'];
  let extraBad = { t: 0, list: [] };
  async function badList() {                                           // admin kengaytmasi (10 daqiqada bir yangilanadi)
    if (Date.now() - extraBad.t > 600000) {
      const v = await H.get('settings/badwords');
      extraBad = { t: Date.now(), list: (Array.isArray(v) ? v : Object.values(v || {})).map(x => String(x).toLowerCase()).filter(x => x.length >= 3) };
    }
    return extraBad.list;
  }
  const leet = s => String(s).toLowerCase().replace(/[ʻʼ’‘`´′']/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/\$/g, 's').replace(/@/g, 'a').replace(/[^a-z0-9а-яёқғҳў\s]/gi, ' ');
  async function hasBadWord(text) {
    const toks = leet(text).split(/\s+/).filter(Boolean), extra = await badList();
    return toks.some(t => BAD_EXACT.includes(t) || BAD_STEMS.some(s => t.startsWith(s)) || extra.some(s => t.startsWith(s)));
  }
  function contactKind(text, allowLinks) {
    const s = String(text);
    if (/@[a-z0-9_]{3,}/i.test(s) || /(t\.me|telegram\.me|wa\.me)\//i.test(s)) return 'username yoki Telegram havolasi';
    const runs = s.match(/\+?\d[\d\s\-()]{7,}\d/g) || [];
    if (runs.some(x => x.replace(/\D/g, '').length >= 9)) return 'telefon raqam';
    if (!allowLinks && (/https?:\/\//i.test(s) || /\bwww\./i.test(s) || /\b[a-z0-9-]+\.(com|uz|ru|org|net|me|io|app|tk|xyz|info|link)\b/i.test(s))) return 'havola';
    return null;
  }
  app.locals.chatFilters = { hasBadWord, contactKind };

  // ------------------------------------------------------------------ TEZLIK CHEGARASI (xotirada)
  const rl = new Map(), notified = new Map(), seen = new Map();
  function rateOk(key, text) {
    const now = Date.now(); let r = rl.get(key);
    if (!r) { r = { last: 0, times: [], lastText: '', lastAt: 0 }; rl.set(key, r); }
    if (now - r.last < 2500) return 'Juda tez yozyapsiz — bir oz kuting';
    r.times = r.times.filter(t => now - t < 60000);
    if (r.times.length >= 15) return "Daqiqada 15 tadan ko'p xabar yozib bo'lmaydi";
    if (text === r.lastText && now - r.lastAt < 30000) return 'Bir xil xabarni qayta yuborib bo\'lmaydi';
    r.last = now; r.times.push(now); r.lastText = text; r.lastAt = now;
    if (rl.size > 5000) for (const [k, v] of rl) if (now - v.last > 120000) rl.delete(k);
    return null;
  }

  // ------------------------------------------------------------------ KIRISH HUQUQI
  // Guruhga faqat a'zo yoki ustoz kira oladi; bloklangan foydalanuvchi va bloklangan ustozning sinfi yopiq.
  async function access(code, uid) {
    const c = await H.cls(code);
    if (!c) return { error: [404, 'Guruh topilmadi'] };
    if (await H.blocked(uid)) return { error: [403, 'Sizning hisobingiz cheklangan'] };
    const isTeacher = String(c.teacherId) === String(uid);
    if (!isTeacher && !(await H.get(`class_members/${code}/${uid}`))) return { error: [403, "Siz bu guruh a'zosi emassiz"] };
    if (!isTeacher && (await H.blocked(c.teacherId))) return { error: [403, 'Bu guruh vaqtincha yopilgan'] };
    return { c, isTeacher };
  }
  const teacherOnly = async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return null;
    const code = H.cleanCode((req.body || {}).code || (req.query || {}).code);
    const c = await H.cls(code);
    if (!c || String(c.teacherId) !== uid) { err(res, 403, "Faqat sinf ustozi qila oladi"); return null; }
    if (await H.blocked(uid)) { err(res, 403, 'Sizning hisobingiz cheklangan'); return null; }
    return { uid, code, c };
  };

  // ------------------------------------------------------------------ USTOZ QIDIRISH
  app.get('/api/teacher/search', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const tokens = leet(req.query.q || '').split(/\s+/).filter(Boolean).slice(0, 5);
    const scope = ['district', 'inst'].includes(req.query.scope) ? req.query.scope : 'all';
    const [db, classes, mem, myReq] = await Promise.all([H.users(), H.get('classes'), H.get('class_members'), H.get('user_requests/' + uid)]);
    const me = db[uid] || {}, by = {};
    Object.values(classes || {}).filter(c => c.searchable !== false).forEach(c => { (by[c.teacherId] = by[c.teacherId] || []).push(c); });
    const out = [];
    for (const t of Object.keys(by)) {
      const e = db[t];
      if (!e || e.role !== 'teacher' || e.blocked || e.hiddenTeacher || t === uid) continue;
      if (scope === 'district' && !(me.region && e.region === me.region && e.district === me.district)) continue;
      if (scope === 'inst' && !(me.instId && e.instId === me.instId)) continue;
      const hay = leet([H.dname(e), e.subject || '', e.instName || ''].join(' '));
      if (!tokens.every(k => hay.includes(k))) continue;
      const cls = [];
      for (const c of by[t]) {
        const alias = await H.alias(c.code), count = Object.keys((mem || {})[c.code] || {}).length;
        const status = ((mem || {})[c.code] || {})[uid] ? 'member' : ((myReq || {})[c.code] ? 'requested' : null);
        cls.push({ alias, name: c.name, count, full: count >= (e.verifiedTeacher ? H.CAP_VERIFIED : H.CAP_UNVERIFIED), status });
      }
      out.push({ name: H.dname(e), subject: e.subject || null, instName: e.instName || null, district: e.district || null, verified: !!e.verifiedTeacher, students: cls.reduce((a, c) => a + c.count, 0), classes: cls });
    }
    out.sort((a, b) => (b.verified - a.verified) || (b.students - a.students) || a.name.localeCompare(b.name));
    res.json({ success: true, items: out.slice(0, 30), myRole: me.role || null });
  });

  app.post('/api/teacher/visibility', async (req, res) => {            // ustoz qidiruvdan yashirinishi mumkin
    const uid = H.auth(req, res); if (!uid) return;
    await rtdb.ref(`users/${uid}/hiddenTeacher`).set(!!(req.body || {}).hidden);
    res.json({ success: true });
  });

  // ------------------------------------------------------------------ QO'SHILISH SO'ROVI
  app.post('/api/class/request', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const alias = String((req.body || {}).alias || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const code = alias ? await H.get('class_alias/' + alias) : null;
    const c = await H.cls(code);
    if (!c) return err(res, 404, 'Sinf topilmadi');
    if (await H.blocked(uid)) return err(res, 403, 'Sizning hisobingiz cheklangan');
    if (await H.blocked(c.teacherId)) return err(res, 403, 'Bu sinf vaqtincha yopilgan');
    if (String(c.teacherId) === uid) return err(res, 400, "Bu sizning o'z sinfingiz");
    if (await H.get(`class_members/${code}/${uid}`)) return err(res, 400, 'Siz bu sinfda allaqachon borsiz');
    if ((await H.get(`class_banned/${code}/${uid}`)) === true) return err(res, 403, "Ustoz sizni bu sinfga qo'shmaydi");
    if (await H.get(`class_requests/${code}/${uid}`)) return res.json({ success: true, already: true, name: c.name });
    const dec = await H.get(`class_declined/${code}/${uid}`);
    if (dec && Date.now() - dec < 24 * 3600 * 1000) return err(res, 429, "So'rovingiz yaqinda ko'rib chiqilgan. Ertaga qayta urinib ko'ring.");
    if (Object.keys((await H.get('user_requests/' + uid)) || {}).length >= MAX_PENDING) return err(res, 429, `Bir vaqtda ${MAX_PENDING} tadan ko'p so'rov yuborib bo'lmaydi`);
    if ((await H.members(code)).length >= (await H.cap(c.teacherId))) return err(res, 400, "Bu sinf to'lgan");
    await rtdb.ref(`class_requests/${code}/${uid}`).set({ at: Date.now() });
    await rtdb.ref(`user_requests/${uid}/${code}`).set(Date.now());
    const db = await H.users();
    H.notify(c.teacherId, `📩 Yangi so'rov\n${H.dname(db[uid])} «${c.name}» sinfingizga qo'shilmoqchi.`, { qs: '?sorov=' + code, btn: "📩 So'rovlarni ko'rish" }).catch(() => {});
    res.json({ success: true, name: c.name });
  });

  app.post('/api/class/request-cancel', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const alias = String((req.body || {}).alias || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const code = alias ? await H.get('class_alias/' + alias) : null;
    if (code) { await rtdb.ref(`class_requests/${code}/${uid}`).remove(); await rtdb.ref(`user_requests/${uid}/${code}`).remove(); }
    res.json({ success: true });
  });

  app.get('/api/class/requests', async (req, res) => {
    const t = await teacherOnly(req, res); if (!t) return;
    const reqs = (await H.get('class_requests/' + t.code)) || {}, db = await H.users();
    res.json({ success: true, items: Object.keys(reqs).map(id => ({ id, name: H.dname(db[id]), at: reqs[id].at })).sort((a, b) => a.at - b.at) });
  });

  app.post('/api/class/decide', async (req, res) => {
    const t = await teacherOnly(req, res); if (!t) return;
    const { studentId, accept, ban } = req.body || {};
    if (!H.uidOk(studentId)) return err(res, 400, "Noto'g'ri so'rov");
    if (!(await H.get(`class_requests/${t.code}/${studentId}`))) return err(res, 404, "So'rov topilmadi");
    await rtdb.ref(`class_requests/${t.code}/${studentId}`).remove();
    await rtdb.ref(`user_requests/${studentId}/${t.code}`).remove();
    if (accept) {
      if ((await H.members(t.code)).length >= (await H.cap(t.uid))) return err(res, 400, "Sinf to'lgan. Admin tasdiqlagach (✅ Tasdiqlangan ustoz) 200 tagacha o'quvchi qo'sha olasiz.");
      await rtdb.ref(`class_members/${t.code}/${studentId}`).set({ joinedAt: Date.now() });
      H.notify(studentId, `✅ «${t.c.name}» sinfiga qabul qilindingiz!`, { code: t.code, btn: '💬 Guruhni ochish' }).catch(() => {});
    } else {
      await rtdb.ref(`class_declined/${t.code}/${studentId}`).set(Date.now());
      if (ban) await rtdb.ref(`class_banned/${t.code}/${studentId}`).set(true);
      H.notify(studentId, `«${t.c.name}» sinfiga so'rovingiz qabul qilinmadi.`, { noButton: true }).catch(() => {});
    }
    res.json({ success: true });
  });

  // ------------------------------------------------------------------ SOZLAMALAR / TAVSIYA
  app.post('/api/class/settings', async (req, res) => {
    const t = await teacherOnly(req, res); if (!t) return;
    const b = req.body || {}, patch = {};
    if (b.name !== undefined) { const n = String(b.name).replace(/\s+/g, ' ').trim().slice(0, 40); if (n.length < 2) return err(res, 400, 'Nom kamida 2 belgi'); patch.name = n; }
    if (b.mode !== undefined) { if (!['chat', 'announce'].includes(b.mode)) return err(res, 400, "Rejim noto'g'ri"); patch.mode = b.mode; }
    if (b.searchable !== undefined) patch.searchable = !!b.searchable;
    await rtdb.ref('classes/' + t.code).update(patch);
    if (b.rec !== undefined) {
      if (b.rec === null) await rtdb.ref(`classes/${t.code}/rec`).remove();
      else {
        const key = String(b.rec.topicKey || ''), text = String(b.rec.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!/^(\d{1,2}_\d{1,2}|masala_\d{1,2})$/.test(key)) return err(res, 400, 'Mavzu tanlanmagan');
        const rec = { topicKey: key, text, until: Date.now() + 7 * 24 * 3600 * 1000, at: Date.now() };
        await rtdb.ref(`classes/${t.code}/rec`).set(rec);
        const nm = topics[key] || key;
        const note = `📌 Ustoz tavsiyasi: shu hafta «${nm}» mavzusini takrorlang.${text ? '\n' + text : ''}`;
        await H.addMsg(t.code, t.uid, note, 'announce', { system: true });
        H.members(t.code).then(ids => H.notifyMany(ids, note, { code: t.code })).catch(() => {});
      }
    }
    res.json({ success: true });
  });

  // ------------------------------------------------------------------ CHAT
  app.get('/api/class/msgs', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const code = H.cleanCode(req.query.code), a = await access(code, uid);
    if (a.error) return err(res, a.error[0], a.error[1]);
    seen.set(code + ':' + uid, Date.now());
    const all = (await H.get('class_msgs/' + code)) || {}, db = await H.users();
    const list = Object.values(all).filter(m => !m.hidden).sort((x, y) => x.at - y.at);
    const shape = m => ({ id: m.id, name: H.dname(db[m.uid]), text: m.text, at: m.at, kind: m.kind || 'chat', system: !!m.system, mine: m.uid === uid, byTeacher: m.uid === a.c.teacherId,
      canDelete: a.isTeacher || m.uid === uid });
    const pinned = a.c.pinned && all[a.c.pinned] && !all[a.c.pinned].hidden ? shape(all[a.c.pinned]) : null;
    res.json({ success: true, name: a.c.name, mode: a.c.mode || 'chat', isTeacher: a.isTeacher, teacherVerified: !!(db[a.c.teacherId] && db[a.c.teacherId].verifiedTeacher),
      teacherName: H.dname(db[a.c.teacherId]), pinned, items: list.slice(-SHOW).map(shape), now: Date.now() });
  });

  app.post('/api/class/msg', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const b = req.body || {}, code = H.cleanCode(b.code), a = await access(code, uid);
    if (a.error) return err(res, a.error[0], a.error[1]);
    const text = String(b.text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return err(res, 400, "Xabar bo'sh");
    if (text.length > MSG_MAX) return err(res, 400, `Xabar ${MSG_MAX} belgidan oshmasin`);
    if (!a.isTeacher && (a.c.mode || 'chat') === 'announce') return err(res, 403, "Bu guruhda faqat ustoz yozadi (e'lonlar rejimi)");
    const kind = a.isTeacher && b.kind === 'announce' ? 'announce' : 'chat';
    const allowLinks = a.isTeacher && (await H.verified(uid));
    const bad = contactKind(text, allowLinks);
    if (bad) return err(res, 400, `Xavfsizlik uchun xabarda ${bad} yozib bo'lmaydi. Aloqa faqat shu guruh ichida bo'ladi.`);
    if (await hasBadWord(text)) return err(res, 400, "Xabarda nomaqbul so'z bor. Iltimos, hurmat bilan yozing.");
    const rate = rateOk(code + ':' + uid, text);
    if (rate) return err(res, 429, rate);
    const msg = await H.addMsg(code, uid, text, kind);
    res.json({ success: true, id: msg.id });

    // bildirishnomalar (javobdan keyin, fonda)
    (async () => {
      const db = await H.users(), ids = (await H.members(code)).concat(a.c.teacherId).filter(x => x !== uid).slice(0, 220);
      if (kind === 'announce') {
        await H.notifyMany(ids, `📢 «${a.c.name}»\n\n${text.slice(0, 300)}`, { code });
      } else {
        const now = Date.now(), todo = ids.filter(u => {
          const k = code + ':' + u;
          if (now - (notified.get(k) || 0) < 30 * 60000) return false;       // 30 daqiqada bir marta
          if (now - (seen.get(k) || 0) < 2 * 60000) return false;           // hozir chatda o'tirgan bo'lsa — kerak emas
          notified.set(k, now); return true;
        });
        await H.notifyMany(todo, `💬 «${a.c.name}» guruhida yangi xabarlar bor (${H.dname(db[uid])}).`, { code, btn: '💬 Guruhni ochish' });
        if (notified.size > 20000) for (const [k, v] of notified) if (now - v > 3600000) notified.delete(k);
      }
    })().catch(e => console.error('[guruh] notify', e && e.message));
  });

  app.post('/api/class/msg/delete', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const b = req.body || {}, code = H.cleanCode(b.code), a = await access(code, uid);
    if (a.error) return err(res, a.error[0], a.error[1]);
    const m = await H.get(`class_msgs/${code}/${String(b.msgId || '').replace(/[.#$/\[\]]/g, '')}`);
    if (!m) return res.json({ success: true });
    if (!a.isTeacher && m.uid !== uid) return err(res, 403, "Faqat o'z xabaringizni o'chira olasiz");
    await rtdb.ref(`class_msgs/${code}/${m.id}`).remove();
    if (a.c.pinned === m.id) await rtdb.ref(`classes/${code}/pinned`).remove();
    res.json({ success: true });
  });

  app.post('/api/class/pin', async (req, res) => {                     // qadalgan e'lon (guruh tepasida turadi)
    const t = await teacherOnly(req, res); if (!t) return;
    const id = String((req.body || {}).msgId || '').replace(/[.#$/\[\]]/g, '');
    if (!id) { await rtdb.ref(`classes/${t.code}/pinned`).remove(); return res.json({ success: true, pinned: null }); }
    if (!(await H.get(`class_msgs/${t.code}/${id}`))) return err(res, 404, 'Xabar topilmadi');
    await rtdb.ref(`classes/${t.code}/pinned`).set(id);
    res.json({ success: true, pinned: id });
  });

  // ------------------------------------------------------------------ SHIKOYAT
  app.post('/api/class/report', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const b = req.body || {}, code = H.cleanCode(b.code), a = await access(code, uid);
    if (a.error) return err(res, a.error[0], a.error[1]);
    const msgId = String(b.msgId || '').replace(/[.#$/\[\]]/g, ''), m = await H.get(`class_msgs/${code}/${msgId}`);
    if (!m) return err(res, 404, 'Xabar topilmadi');
    if (m.uid === uid) return err(res, 400, "O'z xabaringizga shikoyat qilib bo'lmaydi");
    const id = `${msgId}_${uid}`, db = await H.users();
    const tx = await rtdb.ref('reports/' + id).transaction(cur => (cur ? undefined : {
      id, code, className: a.c.name, msgId, targetUid: m.uid, targetName: H.dname(db[m.uid]), text: String(m.text).slice(0, 500), reporterId: uid,
      reason: String(b.reason || '').replace(/\s+/g, ' ').trim().slice(0, 100), at: Date.now(), status: 'open' }));
    if (!tx.committed) return res.json({ success: true, already: true });
    const cnt = await rtdb.ref('msg_reports/' + msgId).transaction(c => (c || 0) + 1);
    if (cnt.snapshot.val() >= 3) await rtdb.ref(`class_msgs/${code}/${msgId}/hidden`).set(true);   // 3 shikoyat — admin ko'rgunicha yashiriladi
    H.notifyAdmins(`🚩 Yangi shikoyat\n«${a.c.name}» · ${H.dname(db[m.uid])}\n“${String(m.text).slice(0, 160)}”\n\nKo'rish: /shikoyatlar`).catch(() => {});
    res.json({ success: true });
  });

  // ------------------------------------------------------------------ ADMIN (faqat botdan, INTERNAL_API_KEY bilan)
  async function adminOnly(req, res) {
    if (!INTERNAL_API_KEY) { err(res, 503, 'INTERNAL_API_KEY sozlanmagan'); return null; }
    if (!checkInternalKey(req, res)) return null;
    const aid = String((req.body || {}).adminUserId || '');
    if (!(await isAuthorizedAdmin({ adminUserId: aid }))) { err(res, 403, 'Admin huquqi tasdiqlanmadi'); return null; }
    return aid;
  }

  app.post('/api/admin/reports', async (req, res) => {
    if (!(await adminOnly(req, res))) return;
    const b = req.body || {};
    if (b.action === 'resolve') {
      const id = String(b.id || '').replace(/[.#$/\[\]]/g, ''), r = await H.get('reports/' + id);
      if (!r) return err(res, 404, 'Shikoyat topilmadi');
      if (!['delete', 'block', 'dismiss'].includes(b.decision)) return err(res, 400, "Qaror noto'g'ri");
      if (b.decision === 'dismiss') {
        await rtdb.ref(`class_msgs/${r.code}/${r.msgId}/hidden`).remove();
      } else {
        await rtdb.ref(`class_msgs/${r.code}/${r.msgId}`).remove();
        if (b.decision === 'block') {
          await rtdb.ref(`users/${r.targetUid}/blocked`).set(true);
          H.notify(r.targetUid, "Hisobingiz guruh qoidalari buzilgani uchun cheklandi. Savol bo'lsa /yordam yozing.", { force: true, noButton: true }).catch(() => {});
        }
      }
      // shu xabarga tegishli barcha ochiq shikoyatlar yopiladi
      const all = (await H.get('reports')) || {};
      for (const k of Object.keys(all)) if (all[k].msgId === r.msgId && all[k].status === 'open') await rtdb.ref(`reports/${k}`).update({ status: b.decision, by: String(b.adminUserId), resolvedAt: Date.now() });
      return res.json({ success: true });
    }
    const all = (await H.get('reports')) || {}, seenMsg = new Set(), items = [];
    for (const r of Object.values(all).filter(x => x.status === 'open').sort((x, y) => y.at - x.at)) {
      if (seenMsg.has(r.msgId)) continue; seenMsg.add(r.msgId);
      items.push({ id: r.id, className: r.className, targetName: r.targetName, targetUid: r.targetUid, text: r.text, reason: r.reason, at: r.at,
        count: Object.values(all).filter(x => x.msgId === r.msgId && x.status === 'open').length });
    }
    res.json({ success: true, total: items.length, items: items.slice(0, 10) });
  });

  app.post('/api/admin/teachers', async (req, res) => {                // ustozlarni tasdiqlash
    if (!(await adminOnly(req, res))) return;
    const b = req.body || {};
    if (b.action === 'verify' || b.action === 'unverify') {
      if (!H.uidOk(b.userId)) return err(res, 400, "Noto'g'ri ID");
      await rtdb.ref(`users/${b.userId}/verifiedTeacher`).set(b.action === 'verify');
      if (b.action === 'verify') H.notify(b.userId, "✅ Siz «Tasdiqlangan ustoz» deb belgilandingiz! Endi sinfingizga 200 tagacha o'quvchi qo'sha olasiz va e'lonlarda havola yozishingiz mumkin.", { open: 'class', btn: '🎓 Sinflarim' }).catch(() => {});
      return res.json({ success: true });
    }
    const [db, classes] = await Promise.all([H.users(true), H.get('classes')]);
    const cnt = {}; Object.values(classes || {}).forEach(c => { cnt[c.teacherId] = (cnt[c.teacherId] || 0) + 1; });
    const items = Object.keys(db).filter(k => db[k] && db[k].role === 'teacher' && cnt[k]).map(k => ({ id: k, name: H.dname(db[k]), subject: db[k].subject || null, inst: db[k].instName || null, classes: cnt[k], verified: !!db[k].verifiedTeacher, blocked: !!db[k].blocked }))
      .sort((x, y) => (x.verified - y.verified) || (y.classes - x.classes));
    res.json({ success: true, total: items.length, items: items.slice(0, 15) });
  });
};
