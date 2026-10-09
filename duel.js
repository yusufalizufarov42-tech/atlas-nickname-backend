// ============================================================================
//  DUEL moduli — do'stni havola orqali duelga chaqirish.
//  Oqim: A "Do'st" rejimini tanlaydi -> /api/duel/create -> kod + havola (t.me/atlasilmbot?startapp=duel_KOD)
//        B havolani ochadi -> /api/duel/accept -> ikkalasi uchun battle sessiyasi yaratiladi
//        A allaqachon ishlatilayotgan /api/battle/queue-status orqali raqib topilganini biladi.
//  Sessiya/javoblar mavjud /api/battle/answer va /api/battle/state orqali ishlaydi (o'zgarmagan).
//  server.js ga BITTA qator:  require('./duel')(app, { rtdb });
//  RTDB: duel_invites/{KOD} -> { creatorId, nickname, questions, createdAt }   (30 daqiqa amal qiladi)
// ============================================================================
'use strict';

module.exports = function mountDuel(app, deps) {
  const { rtdb } = deps;
  const TTL = 30 * 60 * 1000, ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const mkCode = () => Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
  const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const goodQ = q => q && typeof q.q === 'string' && q.q.length <= 400 && Array.isArray(q.opts) && q.opts.length >= 2 && q.opts.length <= 6 && Number.isInteger(q.a) && q.a >= 0 && q.a < q.opts.length;

  app.post('/api/duel/create', async (req, res) => {
    const { userId, nickname, questions } = req.body || {};
    if (!userId || !nickname || !Array.isArray(questions) || questions.length < 1 || questions.length > 30 || !questions.every(goodQ))
      return res.status(400).json({ error: "Noto'g'ri so'rov" });
    const mine = String(userId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = mkCode();
      const tx = await rtdb.ref('duel_invites/' + code).transaction(cur => (cur && Date.now() - cur.createdAt < TTL ? undefined : { creatorId: mine, nickname: String(nickname).slice(0, 40), questions, createdAt: Date.now() }));
      if (tx.committed) return res.json({ success: true, code });
    }
    res.status(500).json({ error: "Kod yaratib bo'lmadi, qayta urinib ko'ring" });
  });

  app.post('/api/duel/accept', async (req, res) => {
    const { code, userId, nickname } = req.body || {};
    const c = cleanCode(code);
    if (!c || !userId || !nickname) return res.status(400).json({ error: "Noto'g'ri so'rov" });
    let invite = null, why = null;
    await rtdb.ref('duel_invites/' + c).transaction(cur => {
      invite = null; why = null;
      if (!cur) { why = 'yoq'; return cur; }
      if (Date.now() - (cur.createdAt || 0) > TTL) { why = 'eskirgan'; return null; }
      if (String(cur.creatorId) === String(userId)) { why = 'ozi'; return cur; }
      invite = cur; return null;                                                   // bitta marta ishlatiladi
    });
    if (!invite) return res.status(why === 'ozi' ? 400 : 404).json({ error: why === 'ozi' ? "Bu sizning o'z havolangiz — uni do'stingizga yuboring" : why === 'eskirgan' ? "Havola muddati o'tgan (30 daqiqa)" : "Havola topilmadi yoki allaqachon ishlatilgan" });
    const me = String(userId), nick = String(nickname).slice(0, 40);
    const sessionId = 'battle_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await rtdb.ref('battle_sessions/' + sessionId).set({ players: { [invite.creatorId]: invite.nickname, [me]: nick }, questions: invite.questions, answers: {}, createdAt: Date.now(), friendDuel: true });
    await rtdb.ref('battle_matches/' + invite.creatorId).set({ sessionId, opponentNickname: nick, questions: invite.questions });
    res.json({ success: true, sessionId, opponentNickname: invite.nickname, questions: invite.questions });
  });

  app.post('/api/duel/cancel', async (req, res) => {
    const { code, userId } = req.body || {}, c = cleanCode(code);
    if (c && userId) await rtdb.ref('duel_invites/' + c).transaction(cur => (cur && String(cur.creatorId) === String(userId) ? null : cur));
    res.json({ success: true });
  });
};
