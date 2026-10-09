// ============================================================================
//  VIKTORINA moduli — savolni Telegram "quiz" (viktorina) so'rovnomasi ko'rinishida hammaga
//  yuboradi: odam variantni bosadi, to'g'ri javob va tahlil (izoh) darhol ko'rinadi.
//  Admin necha kishi yechganini, nechtasi to'g'ri topganini va variantlar bo'yicha taqsimotni ko'radi.
//  server.js ga BITTA qator qo'shiladi (eslatma ulangan joyning yonida):
//      require('./viktorina')(app, { rtdb, BOT_TOKEN, loadDB, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY });
//
//  Oqim: bot.py (/viktorina) -> POST /api/admin/quiz/send  -> server har bir foydalanuvchiga sendPoll yuboradi
//        foydalanuvchi javob beradi -> bot.py (poll_answer) -> POST /api/quiz/answer -> bazaga yoziladi
//        bot.py (/natija)         -> POST /api/admin/quiz/stats -> hisobot
//
//  Telegram chegaralari: savol <=300, variant <=100 (2–10 ta), tahlil <=200 belgi.
//
//  RTDB: quiz/{id}            savol, variantlar, to'g'ri javob, yuborish hisobi
//        quiz_list/{id}       -> createdAt (oxirgilarini topish uchun)
//        quiz_poll/{pollId}   -> "quizId:userId" (javobni qaysi viktorinaga tegishli ekanini topish)
//        quiz_ans/{id}/{uid}  {opt, ok, at}
// ============================================================================
'use strict';

module.exports = function mountQuiz(app, deps) {
  const { rtdb, BOT_TOKEN, loadDB, isAuthorizedAdmin, checkInternalKey, INTERNAL_API_KEY } = deps;
  const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = async p => (await rtdb.ref(p).once('value')).val();
  const str = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const fail = (res, s, error) => res.status(s).json({ success: false, error });
  let running = false;

  function clean(b) {
    const question = str(b.question);
    const options = (Array.isArray(b.options) ? b.options : []).map(str);
    const explanation = str(b.explanation);
    const correct = Number(b.correct);
    if (!question) return { error: 'Savol matni bo\'sh' };
    if (question.length > 300) return { error: `Savol ${question.length} belgi, 300 dan oshmasin` };
    if (options.length < 2 || options.length > 10) return { error: 'Variantlar soni 2 dan 10 gacha bo\'lsin' };
    const bad = options.findIndex(o => !o || o.length > 100);
    if (bad >= 0) return { error: `${String.fromCharCode(65 + bad)} variant bo'sh yoki 100 belgidan uzun` };
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) return { error: 'To\'g\'ri javob ko\'rsatilmagan' };
    if (explanation.length > 200) return { error: `Tahlil ${explanation.length} belgi, Telegram 200 dan oshiq ruxsat bermaydi` };
    return { question, options, correct, explanation };
  }

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

  // 1) Hammaga yuborish (admin, faqat botdan)
  app.post('/api/admin/quiz/send', async (req, res) => {
    if (!INTERNAL_API_KEY) return fail(res, 503, 'INTERNAL_API_KEY sozlanmagan');
    if (!checkInternalKey(req, res)) return;
    const b = req.body || {}, adminId = String(b.adminUserId || '');
    if (!(await isAuthorizedAdmin({ adminUserId: adminId }))) return fail(res, 403, 'Admin huquqi tasdiqlanmadi');
    const q = clean(b);
    if (q.error) return fail(res, 400, q.error);
    if (!BOT_TOKEN) return fail(res, 500, 'BOT_TOKEN sozlanmagan');
    if (running) return fail(res, 409, 'Oldingi viktorina hali yuborilmoqda, biroz kuting');

    const db = (await loadDB()) || {};
    const ids = Object.keys(db).filter(k => /^\d+$/.test(k) && k !== adminId);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5), now = Date.now();
    await rtdb.ref(`quiz/${id}`).set({ id, adminId, question: q.question, options: q.options, correct: q.correct, explanation: q.explanation, createdAt: now, total: ids.length, sent: 0, blocked: 0, status: 'sending' });
    await rtdb.ref(`quiz_list/${id}`).set(now);
    running = true;
    res.json({ success: true, quizId: id, total: ids.length });

    (async () => {
      let sent = 0, blocked = 0, other = 0;
      for (const uid of ids) {
        const r = await tg('sendPoll', { chat_id: uid, question: q.question, options: q.options.map(text => ({ text })), type: 'quiz', correct_option_id: q.correct,
          is_anonymous: false, ...(q.explanation ? { explanation: q.explanation } : {}) });
        if (r.ok && r.result && r.result.poll) { sent++; await rtdb.ref(`quiz_poll/${r.result.poll.id}`).set(`${id}:${uid}`); }
        else if (r.blocked) blocked++; else other++;
        if ((sent + blocked + other) % 50 === 0) await rtdb.ref(`quiz/${id}`).update({ sent, blocked });
        await sleep(40);
      }
      await rtdb.ref(`quiz/${id}`).update({ sent, blocked, status: 'done' });
      await tg('sendMessage', { chat_id: adminId, text: `✅ Viktorina yuborildi\n👥 Jami: ${ids.length}\n📬 Yetkazildi: ${sent}\n🚫 Botni bloklagan: ${blocked}\n❌ Boshqa xato: ${other}\n\nNatijani ko'rish: /natija` });
    })().catch(e => console.error('[viktorina]', e && e.message)).finally(() => { running = false; });
  });

  // 2) Foydalanuvchi javob berdi (botdan)
  app.post('/api/quiz/answer', async (req, res) => {
    if (!INTERNAL_API_KEY) return fail(res, 503, 'INTERNAL_API_KEY sozlanmagan');
    if (!checkInternalKey(req, res)) return;
    const { pollId, userId, optionIds } = req.body || {};
    if (!/^\d+$/.test(String(pollId || '')) || !/^\d+$/.test(String(userId || ''))) return fail(res, 400, 'Noto\'g\'ri so\'rov');
    const link = await get(`quiz_poll/${pollId}`);
    if (!link) return res.json({ success: true, ignored: true });                    // bizniki emas (masalan, admin ko'rinishi)
    const [quizId, uid] = String(link).split(':');
    if (uid !== String(userId)) return fail(res, 403, 'Foydalanuvchi mos kelmadi');
    const quiz = await get(`quiz/${quizId}`);
    if (!quiz) return res.json({ success: true, ignored: true });
    const opt = Array.isArray(optionIds) && optionIds.length ? Number(optionIds[0]) : null;
    if (opt === null) return res.json({ success: true, retracted: true });         // quiz'da javobni qaytarib bo'lmaydi, lekin ehtiyot uchun
    if (!Number.isInteger(opt) || opt < 0 || opt >= quiz.options.length) return fail(res, 400, 'Variant noto\'g\'ri');
    const tx = await rtdb.ref(`quiz_ans/${quizId}/${uid}`).transaction(c => (c ? undefined : { opt, ok: opt === quiz.correct, at: Date.now() }));
    if (tx.committed && app.locals.bumpWeek) app.locals.bumpWeek(uid, opt === quiz.correct ? 1 : 0, 1);   // haftalik hisobot uchun
    res.json({ success: true, counted: tx.committed });
  });

  // 3) Hisobot (admin)
  app.post('/api/admin/quiz/stats', async (req, res) => {
    if (!INTERNAL_API_KEY) return fail(res, 503, 'INTERNAL_API_KEY sozlanmagan');
    if (!checkInternalKey(req, res)) return;
    const b = req.body || {};
    if (!(await isAuthorizedAdmin({ adminUserId: String(b.adminUserId || '') }))) return fail(res, 403, 'Admin huquqi tasdiqlanmadi');
    let quizId = String(b.quizId || '').replace(/[^a-z0-9]/gi, '');
    const list = (await get('quiz_list')) || {};
    const ordered = Object.keys(list).sort((x, y) => list[y] - list[x]);
    if (!quizId) { const back = Math.max(1, parseInt(b.back, 10) || 1); quizId = ordered[back - 1]; }
    if (!quizId) return fail(res, 404, 'Hali viktorina yuborilmagan');
    const quiz = await get(`quiz/${quizId}`);
    if (!quiz) return fail(res, 404, 'Viktorina topilmadi');
    const ans = (await get(`quiz_ans/${quizId}`)) || {};
    const perOption = quiz.options.map(() => 0); let correct = 0;
    Object.values(ans).forEach(a => { perOption[a.opt]++; if (a.ok) correct++; });
    res.json({ success: true, quiz: { id: quiz.id, question: quiz.question, options: quiz.options, correct: quiz.correct, createdAt: quiz.createdAt, total: quiz.total, sent: quiz.sent || 0, blocked: quiz.blocked || 0, status: quiz.status },
      answered: Object.keys(ans).length, correct, perOption, count: ordered.length });
  });

  module.exports.__internal = { clean };
};
