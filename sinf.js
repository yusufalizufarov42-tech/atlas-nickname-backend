// ============================================================================
//  SINF (USTOZ REJIMI) moduli — ustoz sinf yaratadi, o'quvchilar kod/havola bilan qo'shiladi,
//  ustoz sinf statistikasini va xato ko'p mavzularni ko'radi.
//  server.js ga BITTA qator:  require('./sinf')(app, { rtdb, loadDB });
//  RTDB: classes/{KOD} {code, teacherId, name, createdAt} · class_members/{KOD}/{uid} {joinedAt}
//  Statistika mavjud ma'lumotlardan olinadi: users/{id}.topicStats, .week, .atoms (yangi yozuv kerak emas).
//  topics.json (mavzu nomlari) bo'lsa — mavzular nomi bilan ko'rsatiladi.
// ============================================================================
'use strict';

module.exports = function mountClasses(app, deps) {
  const { rtdb, loadDB } = deps;
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', MAX_CLASSES = 5, MAX_MEMBERS = 200;
  let topics = {}; try { topics = require('./topics.json'); } catch (e) { /* ixtiyoriy */ }
  const code6 = () => Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
  const clean = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const uidOk = u => /^\d+$/.test(String(u || ''));
  const get = async p => (await rtdb.ref(p).once('value')).val();
  const nameOf = e => (e && (e.nickname || e.fullName || e.telegramFirstName)) || "O'quvchi";
  const mondayOf = () => { const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date()) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const err = (res, s, m) => res.status(s).json({ success: false, error: m });
  const myClasses = async uid => {                                     // [{code, name, teacherId, isTeacher}]
    const all = (await get('classes')) || {}, mem = (await get('class_members')) || {};
    return Object.values(all).filter(c => String(c.teacherId) === uid || (mem[c.code] && mem[c.code][uid])).map(c => ({ ...c, isTeacher: String(c.teacherId) === uid, count: Object.keys(mem[c.code] || {}).length }));
  };
  const teacherOwns = async (uid, code) => { const c = await get('classes/' + code); return c && String(c.teacherId) === String(uid) ? c : null; };

  app.post('/api/class/create', async (req, res) => {
    const uid = String((req.body || {}).userId || ''), name = String((req.body || {}).name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!uidOk(uid) || name.length < 2) return err(res, 400, "Sinf nomi kamida 2 belgi bo'lsin");
    if ((await myClasses(uid)).filter(c => c.isTeacher).length >= MAX_CLASSES) return err(res, 400, `Eng ko'pi bilan ${MAX_CLASSES} ta sinf yaratish mumkin`);
    for (let i = 0; i < 6; i++) {
      const code = code6();
      const tx = await rtdb.ref('classes/' + code).transaction(c => (c ? undefined : { code, teacherId: uid, name, createdAt: Date.now() }));
      if (tx.committed) return res.json({ success: true, code, name });
    }
    err(res, 500, "Kod yaratib bo'lmadi, qayta urinib ko'ring");
  });

  app.get('/api/class/info', async (req, res) => {                     // havola orqali kirganda nomini ko'rsatish uchun
    const c = await get('classes/' + clean(req.query.code));
    if (!c) return err(res, 404, 'Sinf topilmadi');
    const db = (await loadDB()) || {};
    res.json({ success: true, name: c.name, teacherName: nameOf(db[c.teacherId]) });
  });

  app.post('/api/class/join', async (req, res) => {
    const uid = String((req.body || {}).userId || ''), code = clean((req.body || {}).code);
    if (!uidOk(uid) || !code) return err(res, 400, "Noto'g'ri so'rov");
    const c = await get('classes/' + code);
    if (!c) return err(res, 404, "Bunday sinf topilmadi — kodni tekshiring");
    if (String(c.teacherId) === uid) return err(res, 400, "Bu sizning o'z sinfingiz");
    const mem = (await get('class_members/' + code)) || {};
    if (mem[uid]) return res.json({ success: true, name: c.name, already: true });
    if (Object.keys(mem).length >= MAX_MEMBERS) return err(res, 400, "Sinf to'lgan");
    if ((await myClasses(uid)).filter(x => !x.isTeacher).length >= MAX_CLASSES) return err(res, 400, `Eng ko'pi bilan ${MAX_CLASSES} ta sinfga qo'shilish mumkin`);
    await rtdb.ref(`class_members/${code}/${uid}`).set({ joinedAt: Date.now() });
    res.json({ success: true, name: c.name });
  });

  app.post('/api/class/leave', async (req, res) => {
    const uid = String((req.body || {}).userId || ''), code = clean((req.body || {}).code);
    if (uidOk(uid) && code) await rtdb.ref(`class_members/${code}/${uid}`).remove();
    res.json({ success: true });
  });

  app.get('/api/class/mine', async (req, res) => {
    const uid = String(req.query.userId || '');
    if (!uidOk(uid)) return err(res, 400, 'userId kerak');
    const list = await myClasses(uid);
    res.json({ success: true, teaching: list.filter(c => c.isTeacher).map(c => ({ code: c.code, name: c.name, count: c.count })), joined: list.filter(c => !c.isTeacher).map(c => ({ code: c.code, name: c.name })) });
  });

  app.get('/api/class/stats', async (req, res) => {
    const uid = String(req.query.userId || ''), code = clean(req.query.code);
    const c = await teacherOwns(uid, code);
    if (!c) return err(res, 403, "Bu sinf statistikasini faqat ustoz ko'ra oladi");
    const ids = Object.keys((await get('class_members/' + code)) || {}), db = (await loadDB()) || {}, mon = mondayOf();
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
      return { id, name: nameOf(e), atoms: e.atoms || 0, weekTotal: w.t, weekCorrect: w.c, total: t, accuracy: t ? Math.round(100 * cc / t) : null, weak: weak && weak.pct < 70 ? weak : null };
    }).sort((a, b) => b.weekTotal - a.weekTotal || b.total - a.total);
    const weakTopics = Object.entries(agg).filter(([, a]) => a.total >= 5).map(([k, a]) => ({ key: k, name: topics[k] || k, total: a.total, correct: a.correct, pct: Math.round(100 * a.correct / a.total), students: a.students })).sort((a, b) => a.pct - b.pct).slice(0, 10);
    res.json({ success: true, name: c.name, code, count: ids.length, activeThisWeek: active, accuracy: tT ? Math.round(100 * tC / tT) : null, students, weakTopics });
  });

  app.post('/api/class/remove', async (req, res) => {                  // ustoz o'quvchini chiqaradi
    const b = req.body || {}, code = clean(b.code);
    if (!(await teacherOwns(b.userId, code))) return err(res, 403, 'Ruxsat yo\'q');
    if (uidOk(b.studentId)) await rtdb.ref(`class_members/${code}/${b.studentId}`).remove();
    res.json({ success: true });
  });

  app.post('/api/class/delete', async (req, res) => {
    const b = req.body || {}, code = clean(b.code);
    if (!(await teacherOwns(b.userId, code))) return err(res, 403, 'Ruxsat yo\'q');
    await rtdb.ref('classes/' + code).remove(); await rtdb.ref('class_members/' + code).remove();
    res.json({ success: true });
  });
};
