// ============================================================================
//  SINF (USTOZ REJIMI) moduli — v2 (xavfsiz): ustoz sinf yaratadi, o'quvchilar kod/havola bilan qo'shiladi
//  yoki ustozni qidirib so'rov yuboradi (guruh.js). Ustoz statistikani ko'radi.
//
//  server.js ga BITTA qator:
//      require('./sinf')(app, { rtdb, loadDB, BOT_TOKEN, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY });
//  (ortak.js, guruh.js, uyvazifa.js ham shu deps bilan ulanadi)
//
//  v2 o'zgarishlari:
//   • Shaxs Telegram initData imzosidan olinadi (userId ni so'rovga yozib bo'lmaydi).
//   • Ustoz o'quvchining TO'LIQ ISMI va TELEFONINI ko'rmaydi — faqat taxallus yoki Telegram ismi.
//   • Sinf yaratish uchun botda rol = "Ustoz" bo'lishi kerak (/rol).
//   • Tasdiqlanmagan ustoz sinfida eng ko'pi bilan 10 o'quvchi (admin /tasdiq qilgach — 200).
//   • Ustoz o'quvchini chiqarib, qayta qo'shilishni taqiqlashi mumkin (ban).
//
//  RTDB: classes/{KOD} {code, teacherId, name, createdAt, alias, mode, searchable, pinned, rec, cstreak}
//        class_members/{KOD}/{uid} {joinedAt} · class_banned/{KOD}/{uid} · class_alias/{alias} -> KOD
//        class_requests/{KOD}/{uid} {at} · user_requests/{uid}/{KOD} -> at
// ============================================================================
'use strict';

module.exports = function mountClasses(app, deps) {
  const H = require('./ortak')(app, deps);
  const { rtdb } = deps;
  const MAX_CLASSES = 5;
  let topics = {}; try { topics = require('./topics.json'); } catch (e) { /* ixtiyoriy */ }
  const err = H.fail;
  const myClasses = async uid => {                                     // [{code, name, teacherId, isTeacher, count}]
    const all = (await H.get('classes')) || {}, mem = (await H.get('class_members')) || {};
    return Object.values(all).filter(c => String(c.teacherId) === uid || (mem[c.code] && mem[c.code][uid])).map(c => ({ ...c, isTeacher: String(c.teacherId) === uid, count: Object.keys(mem[c.code] || {}).length }));
  };
  const teacherOwns = async (uid, code) => { const c = await H.cls(code); return c && String(c.teacherId) === String(uid) ? c : null; };
  app.locals.teacherOwns = teacherOwns;

  async function wipeClass(code) {
    const reqs = (await H.get('class_requests/' + code)) || {};
    for (const u of Object.keys(reqs)) await rtdb.ref(`user_requests/${u}/${code}`).remove();
    const c = await H.get('classes/' + code);
    if (c && c.alias) await rtdb.ref('class_alias/' + c.alias).remove();
    for (const p of ['classes', 'class_members', 'class_msgs', 'class_requests', 'class_banned', 'hw', 'hw_sub']) await rtdb.ref(`${p}/${code}`).remove();
  }

  app.post('/api/class/create', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const name = String((req.body || {}).name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (name.length < 2) return err(res, 400, "Sinf nomi kamida 2 belgi bo'lsin");
    if (await H.blocked(uid)) return err(res, 403, 'Sizning hisobingiz cheklangan');
    const me = await H.get('users/' + uid);
    if (!me || me.role !== 'teacher') return err(res, 403, "Sinf yaratish uchun avval botda /rol buyrug'i orqali «Ustoz» ekaningizni tanlang.");
    const mine = (await myClasses(uid)).filter(c => c.isTeacher);
    if (mine.length >= MAX_CLASSES) return err(res, 400, `Eng ko'pi bilan ${MAX_CLASSES} ta sinf yaratish mumkin`);
    for (let i = 0; i < 6; i++) {
      const code = H.rnd(6);
      const tx = await rtdb.ref('classes/' + code).transaction(c => (c ? undefined : { code, teacherId: uid, name, createdAt: Date.now(), mode: 'chat', searchable: true }));
      if (tx.committed) {
        await H.alias(code);
        if (!mine.length && !(await H.verified(uid))) {              // yangi ustoz: admin tasdiqlashi uchun xabar
          H.notifyAdmins(`🆕 Yangi ustoz sinf yaratdi\n👤 ${H.dname(me)} · ${me.subject || 'fan ko\'rsatilmagan'} · ${me.instName || 'muassasa yo\'q'}\n🆔 ${uid}\n\nTasdiqlash: /tasdiq`).catch(() => {});
        }
        return res.json({ success: true, code, name });
      }
    }
    err(res, 500, "Kod yaratib bo'lmadi, qayta urinib ko'ring");
  });

  app.get('/api/class/info', async (req, res) => {                     // havola orqali kirganda nomini ko'rsatish uchun
    if (!H.auth(req, res)) return;
    const c = await H.cls(H.cleanCode(req.query.code));
    if (!c) return err(res, 404, 'Sinf topilmadi');
    const db = await H.users();
    res.json({ success: true, name: c.name, teacherName: H.dname(db[c.teacherId]), verified: !!(db[c.teacherId] && db[c.teacherId].verifiedTeacher) });
  });

  app.post('/api/class/join', async (req, res) => {                    // kod/havola orqali (ustoz kodni o'zi bergan) — darhol qo'shiladi
    const uid = H.auth(req, res); if (!uid) return;
    const code = H.cleanCode((req.body || {}).code);
    if (!code) return err(res, 400, "Noto'g'ri so'rov");
    const c = await H.cls(code);
    if (!c) return err(res, 404, 'Bunday sinf topilmadi — kodni tekshiring');
    if (await H.blocked(uid)) return err(res, 403, 'Sizning hisobingiz cheklangan');
    if (await H.blocked(c.teacherId)) return err(res, 403, 'Bu sinf vaqtincha yopilgan');
    if (String(c.teacherId) === uid) return err(res, 400, "Bu sizning o'z sinfingiz");
    if ((await H.get(`class_banned/${code}/${uid}`)) === true) return err(res, 403, "Ustoz sizni bu sinfga qo'shmaydi");
    const mem = (await H.get('class_members/' + code)) || {};
    if (mem[uid]) return res.json({ success: true, name: c.name, already: true });
    if (Object.keys(mem).length >= (await H.cap(c.teacherId))) return err(res, 400, "Sinf to'lgan (tasdiqlanmagan ustoz sinfida 10 tagacha o'quvchi bo'ladi)");
    if ((await myClasses(uid)).filter(x => !x.isTeacher).length >= MAX_CLASSES) return err(res, 400, `Eng ko'pi bilan ${MAX_CLASSES} ta sinfga qo'shilish mumkin`);
    await rtdb.ref(`class_members/${code}/${uid}`).set({ joinedAt: Date.now() });
    await rtdb.ref(`class_requests/${code}/${uid}`).remove(); await rtdb.ref(`user_requests/${uid}/${code}`).remove();
    res.json({ success: true, name: c.name });
  });

  app.post('/api/class/leave', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const code = H.cleanCode((req.body || {}).code);
    if (code) await rtdb.ref(`class_members/${code}/${uid}`).remove();
    res.json({ success: true });
  });

  app.get('/api/class/mine', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const list = await myClasses(uid), db = await H.users();
    const now = Date.now(), teaching = [];
    for (const c of list.filter(x => x.isTeacher)) {
      const pend = Object.keys((await H.get('class_requests/' + c.code)) || {}).length;
      teaching.push({ code: c.code, name: c.name, count: c.count, alias: await H.alias(c.code), mode: c.mode || 'chat', searchable: c.searchable !== false, pending: pend, rec: c.rec && c.rec.until > now ? c.rec : null, cstreak: c.cstreak ? c.cstreak.n : 0 });
    }
    const joined = list.filter(x => !x.isTeacher).map(c => ({ code: c.code, name: c.name, mode: c.mode || 'chat', teacherName: H.dname(db[c.teacherId]), teacherVerified: !!(db[c.teacherId] && db[c.teacherId].verifiedTeacher), rec: c.rec && c.rec.until > now ? c.rec : null, cstreak: c.cstreak ? c.cstreak.n : 0 }));
    const reqs = (await H.get('user_requests/' + uid)) || {}, requested = [];
    for (const code of Object.keys(reqs)) {
      const c = await H.cls(code);
      if (c) requested.push({ alias: c.alias, name: c.name, teacherName: H.dname(db[c.teacherId]) }); else await rtdb.ref(`user_requests/${uid}/${code}`).remove();
    }
    const me = db[uid] || {};
    res.json({ success: true, role: me.role || null, verified: !!me.verifiedTeacher, hidden: !!me.hiddenTeacher, cap: await H.cap(uid), teaching, joined, requested });
  });

  app.get('/api/class/stats', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const code = H.cleanCode(req.query.code);
    const c = await teacherOwns(uid, code);
    if (!c) return err(res, 403, "Bu sinf statistikasini faqat ustoz ko'ra oladi");
    const ids = Object.keys((await H.get('class_members/' + code)) || {}), db = await H.users(true), mon = H.mondayOf();
    const agg = {}; let tT = 0, tC = 0, active = 0;
    const students = ids.map(id => {
      const e = db[id] || {}, ts = e.topicStats || {}, w = e.week && e.week.m === mon ? e.week : { t: 0, c: 0 };
      let t = 0, cc = 0, weak = null;
      for (const k in ts) {
        const s = ts[k]; t += s.total; cc += s.correct;
        const a = agg[k] = agg[k] || { total: 0, correct: 0, students: 0 }; a.total += s.total; a.correct += s.correct; a.students++;
        if (s.total >= 3) { const p = Math.round(100 * s.correct / s.total); if (!weak || p < weak.pct) weak = { key: k, name: topics[k] || k, pct: p }; }
      }
      tT += t; tC += cc; if (w.t > 0) active++;
      return { id, name: H.dname(e), atoms: e.atoms || 0, weekTotal: w.t, weekCorrect: w.c, total: t, accuracy: t ? Math.round(100 * cc / t) : null, weak: weak && weak.pct < 70 ? weak : null };
    }).sort((a, b) => b.weekTotal - a.weekTotal || b.total - a.total);
    const weakTopics = Object.entries(agg).filter(([, a]) => a.total >= 5).map(([k, a]) => ({ key: k, name: topics[k] || k, total: a.total, correct: a.correct, pct: Math.round(100 * a.correct / a.total), students: a.students })).sort((a, b) => a.pct - b.pct).slice(0, 10);
    res.json({ success: true, name: c.name, code, count: ids.length, activeThisWeek: active, accuracy: tT ? Math.round(100 * tC / tT) : null, students, weakTopics, mode: c.mode || 'chat', verified: await H.verified(uid), cap: await H.cap(uid) });
  });

  app.post('/api/class/remove', async (req, res) => {                  // ustoz o'quvchini chiqaradi (ban:true — qayta qo'shila olmaydi)
    const uid = H.auth(req, res); if (!uid) return;
    const b = req.body || {}, code = H.cleanCode(b.code);
    if (!(await teacherOwns(uid, code))) return err(res, 403, "Ruxsat yo'q");
    if (H.uidOk(b.studentId)) {
      await rtdb.ref(`class_members/${code}/${b.studentId}`).remove();
      if (b.ban) await rtdb.ref(`class_banned/${code}/${b.studentId}`).set(true);
    }
    res.json({ success: true });
  });

  app.post('/api/class/delete', async (req, res) => {
    const uid = H.auth(req, res); if (!uid) return;
    const code = H.cleanCode((req.body || {}).code);
    if (!(await teacherOwns(uid, code))) return err(res, 403, "Ruxsat yo'q");
    await wipeClass(code);
    res.json({ success: true });
  });
};
