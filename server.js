// Atlas Kimyo — Backend Server
// Vazifalari:
//  1) Nickname'larning HAQIQIY global yagonaligini tekshirish
//  2) Har bir foydalanuvchining Atom/Anti-modda balansini markazda saqlash
//     (shunda admin boshqa foydalanuvchiga haqiqatda atom bera oladi)
//  3) Admin panel uchun maxsus himoyalangan endpoint
//  4) Referal tizimi (yangi foydalanuvchi chaqirgan egasiga bonus atom berish)
//  5) Kanalga obuna tekshiruvi
//
// MA'LUMOTLAR ENDI Firebase Realtime Database'da saqlanadi (Render'ning
// bepul tarifidagi vaqtinchalik fayl tizimi o'rniga) — shu orqali backend
// qayta ishga tushganda/uxlab-uyg'onganda ham hech qanday ma'lumot
// yo'qolmaydi.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Referal bonusi miqdori (har bir taklif qilingan do'st uchun atom)
const REFERRAL_BONUS = 50;

// Admin nickname va parol shu yerda belgilanadi (parolni env orqali ham berish mumkin)
const ADMIN_NICKNAME = '@atlas_ilmUSTOZ';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '22042000';

// Kanalga obuna tekshiruvi uchun bot tokeni (Render -> Environment bo'limida sozlanadi)
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = '@atlas_ilm';

// ---- Firebase Realtime Database ulanishi ----
// Render'ning Environment bo'limida ikkita o'zgaruvchi kerak:
//  - FIREBASE_SERVICE_ACCOUNT_JSON: Firebase konsolidan yuklab olingan
//    service-account JSON faylining BUTUN TARKIBI (bitta qatorli matn sifatida)
//  - FIREBASE_DB_URL: Realtime Database manzili (masalan
//    https://atlas-kimyo-default-rtdb.firebaseio.com)
let firebaseReady = false;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DB_URL
  });
  firebaseReady = true;
  console.log('Firebase muvaffaqiyatli ulandi.');
} catch (e) {
  console.error('FIREBASE ULANMADI! FIREBASE_SERVICE_ACCOUNT_JSON / FIREBASE_DB_URL muhit o\'zgaruvchilarini tekshiring. Xato:', e.message);
}
const rtdb = firebaseReady ? admin.database() : null;

app.use(cors());
app.use(express.json({ limit: '15mb' })); // fayllar base64 sifatida yuborilgani uchun chegarani oshiramiz

// ---- Ma'lumotlar bazasi bilan ishlash (Firebase Realtime Database) ----
async function loadDB() {
  const snapshot = await rtdb.ref('users').once('value');
  return snapshot.val() || {};
}
async function saveUser(userId, entry) {
  await rtdb.ref('users/' + userId).set(entry);
}
async function patchUser(userId, patch) {
  await rtdb.ref('users/' + userId).update(patch);
}

// ---- Parolni xesh qilish (oddiy SHA-256, ochiq matnda saqlamaslik uchun) ----
function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

// ---- Format tekshiruvlari ----
function isValidNickname(nick) {
  return /^@[a-zA-Z0-9_]{3,19}$/.test(nick);
}
function isValidPassword(pw) {
  return typeof pw === 'string' && pw.length === 8;
}
function isAdminNickname(nick) {
  return nick.toLowerCase() === ADMIN_NICKNAME.toLowerCase();
}

function findEntryByNickname(db, nickname) {
  const uid = Object.keys(db).find(
    k => db[k].nickname.toLowerCase() === nickname.toLowerCase()
  );
  return uid ? { userId: uid, entry: db[uid] } : null;
}

// Firebase ulanmagan bo'lsa, barcha /api so'rovlarini xato bilan to'xtatamiz
// (shovqinsiz "ishlagandek ko'rinib, aslida ishlamaslik"dan ko'ra aniq xato yaxshiroq)
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!firebaseReady) {
    return res.status(503).json({ success: false, error: 'Baza ulanmagan (FIREBASE sozlamalarini tekshiring)' });
  }
  next();
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', firebase: firebaseReady });
});

// POST /api/check-nickname { nickname } -> { available }
app.post('/api/check-nickname', async (req, res) => {
  const { nickname } = req.body || {};
  if (!nickname || !isValidNickname(nickname)) {
    return res.status(400).json({ error: "Noto'g'ri nickname formati" });
  }
  const db = await loadDB();
  const found = findEntryByNickname(db, nickname);
  res.json({ available: !found });
});

// POST /api/register-nickname { nickname, password, userId, referrerId }
// Yangi profil — atom/anti-modda 0 dan boshlanadi (adolat uchun)
app.post('/api/register-nickname', async (req, res) => {
  const { nickname, password, userId, referrerId } = req.body || {};
  if (!nickname || !isValidNickname(nickname)) {
    return res.status(400).json({ success: false, error: "Noto'g'ri nickname formati" });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ success: false, error: "Parol aniq 8 ta belgidan iborat bo'lishi kerak" });
  }
  if (!userId) {
    return res.status(400).json({ success: false, error: 'userId talab qilinadi' });
  }

  const db = await loadDB();
  const existingByNick = findEntryByNickname(db, nickname);

  if (existingByNick && existingByNick.userId !== userId) {
    return res.json({ success: false, error: 'Nickname band' });
  }

  const isNewProfile = !db[userId] || db[userId].nickname.toLowerCase() !== nickname.toLowerCase();

  // REFERAL BONUS LOGIKASI (Faqat yangi profillar yaratilganda)
  if (isNewProfile && referrerId && String(referrerId) !== String(userId) && db[referrerId]) {
    const newReferrerAtoms = (db[referrerId].atoms || 0) + REFERRAL_BONUS;
    await patchUser(referrerId, { atoms: newReferrerAtoms, updatedAt: new Date().toISOString() });
  }

  // Yangi profil uchun tiklash kodi generatsiya qilamiz (faqat shu javobda bir marta ko'rsatiladi)
  const recoveryCode = isNewProfile
    ? Math.floor(100000 + Math.random() * 900000).toString()
    : null;

  const newEntry = {
    nickname,
    passwordHash: hashPassword(password),
    recoveryCodeHash: isNewProfile ? hashPassword(recoveryCode) : (db[userId]?.recoveryCodeHash || null),
    // Yangi nickname (yoki yangi profil) — statistikalar 0 dan boshlanadi (adolat)
    atoms: isNewProfile ? 0 : (db[userId]?.atoms || 0),
    antiModda: isNewProfile ? 0 : (db[userId]?.antiModda || 0),
    referredBy: isNewProfile ? (referrerId || null) : (db[userId]?.referredBy || null),
    unlockedFiles: isNewProfile ? [] : (db[userId]?.unlockedFiles || []),
    documents: isNewProfile ? [] : (db[userId]?.documents || []),
    isAdmin: isAdminNickname(nickname),
    updatedAt: new Date().toISOString()
  };
  await saveUser(userId, newEntry);

  res.json({
    success: true,
    isAdmin: newEntry.isAdmin,
    atoms: newEntry.atoms,
    antiModda: newEntry.antiModda,
    unlockedFiles: newEntry.unlockedFiles,
    documents: newEntry.documents,
    recoveryCode
  });
});

// POST /api/login { nickname, password } -> { success, atoms, antiModda, isAdmin, unlockedFiles, documents }
app.post('/api/login', async (req, res) => {
  const { nickname, password } = req.body || {};
  if (!nickname || !password) {
    return res.status(400).json({ success: false, error: "Nickname va parol talab qilinadi" });
  }
  const db = await loadDB();
  const found = findEntryByNickname(db, nickname);
  if (!found || found.entry.passwordHash !== hashPassword(password)) {
    return res.json({ success: false, error: "Nickname yoki parol noto'g'ri" });
  }
  res.json({
    success: true,
    atoms: found.entry.atoms,
    antiModda: found.entry.antiModda,
    isAdmin: !!found.entry.isAdmin,
    unlockedFiles: found.entry.unlockedFiles || [],
    documents: found.entry.documents || []
  });
});

// POST /api/recover-password { nickname, recoveryCode, newPassword }
app.post('/api/recover-password', async (req, res) => {
  const { nickname, recoveryCode, newPassword } = req.body || {};
  if (!nickname || !recoveryCode || !isValidPassword(newPassword)) {
    return res.status(400).json({ success: false, error: "Barcha maydonlarni to'g'ri to'ldiring (yangi parol 8 belgi)" });
  }
  const db = await loadDB();
  const found = findEntryByNickname(db, nickname);
  if (!found || !found.entry.recoveryCodeHash || found.entry.recoveryCodeHash !== hashPassword(recoveryCode)) {
    return res.json({ success: false, error: "Nickname yoki tiklash kodi noto'g'ri" });
  }
  await patchUser(found.userId, { passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString() });
  res.json({
    success: true,
    atoms: found.entry.atoms,
    antiModda: found.entry.antiModda,
    isAdmin: !!found.entry.isAdmin,
    unlockedFiles: found.entry.unlockedFiles || [],
    documents: found.entry.documents || []
  });
});

// POST /api/sync-balance { nickname, password, atoms, antiModda }
app.post('/api/sync-balance', async (req, res) => {
  const { nickname, password, atoms, antiModda, region, district } = req.body || {};
  if (!nickname || !password) {
    return res.status(400).json({ success: false, error: "Nickname va parol talab qilinadi" });
  }
  const db = await loadDB();
  const found = findEntryByNickname(db, nickname);
  if (!found || found.entry.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ success: false, error: "Avtorizatsiya xato" });
  }

  const patch = { updatedAt: new Date().toISOString() };
  if (typeof atoms === 'number') patch.atoms = atoms;
  if (typeof antiModda === 'number') patch.antiModda = antiModda;
  if (region) patch.region = region;
  if (district) patch.district = district;
  await patchUser(found.userId, patch);

  res.json({ success: true });
});

// POST /api/admin/grant { adminNickname, adminPassword, targetNickname, atoms, antiModda }
app.post('/api/admin/grant', async (req, res) => {
  const { adminNickname, adminPassword, targetNickname, atoms, antiModda } = req.body || {};

  if (!adminNickname || !isAdminNickname(adminNickname) || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: "Admin huquqi tasdiqlanmadi" });
  }
  if (!targetNickname || !isValidNickname(targetNickname)) {
    return res.status(400).json({ success: false, error: "Noto'g'ri maqsadli nickname" });
  }

  const db = await loadDB();
  const found = findEntryByNickname(db, targetNickname);
  if (!found) {
    return res.status(404).json({ success: false, error: "Bunday nickname topilmadi" });
  }

  const newAtoms = (found.entry.atoms || 0) + (Number(atoms) || 0);
  const newAntiModda = (found.entry.antiModda || 0) + (Number(antiModda) || 0);
  await patchUser(found.userId, { atoms: newAtoms, antiModda: newAntiModda, updatedAt: new Date().toISOString() });

  res.json({ success: true, newAtoms, newAntiModda });
});

// POST /api/admin/grant-file { adminNickname, adminPassword, targetNickname, fileId }
app.post('/api/admin/grant-file', async (req, res) => {
  const { adminNickname, adminPassword, targetNickname, fileId } = req.body || {};

  if (!adminNickname || !isAdminNickname(adminNickname) || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: "Admin huquqi tasdiqlanmadi" });
  }
  if (!targetNickname || !isValidNickname(targetNickname) || !fileId) {
    return res.status(400).json({ success: false, error: "Noto'g'ri so'rov" });
  }

  const db = await loadDB();
  const found = findEntryByNickname(db, targetNickname);
  if (!found) {
    return res.status(404).json({ success: false, error: "Bunday nickname topilmadi" });
  }

  const unlockedFiles = found.entry.unlockedFiles || [];
  if (!unlockedFiles.includes(fileId)) unlockedFiles.push(fileId);
  await patchUser(found.userId, { unlockedFiles, updatedAt: new Date().toISOString() });

  res.json({ success: true, unlockedFiles });
});

// POST /api/admin/send-document { adminNickname, adminPassword, targetNickname, fileName, mimeType, fileData }
app.post('/api/admin/send-document', async (req, res) => {
  const { adminNickname, adminPassword, targetNickname, fileName, mimeType, fileData } = req.body || {};

  if (!adminNickname || !isAdminNickname(adminNickname) || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: "Admin huquqi tasdiqlanmadi" });
  }
  if (!targetNickname || !isValidNickname(targetNickname) || !fileName || !fileData) {
    return res.status(400).json({ success: false, error: "Noto'g'ri so'rov — fayl va nickname talab qilinadi" });
  }
  if (fileData.length > 14 * 1024 * 1024) {
    return res.status(413).json({ success: false, error: "Fayl juda katta (maksimal ~10MB)" });
  }

  const db = await loadDB();
  const found = findEntryByNickname(db, targetNickname);
  if (!found) {
    return res.status(404).json({ success: false, error: "Bunday nickname topilmadi" });
  }

  const documents = found.entry.documents || [];
  documents.push({
    id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    fileName,
    mimeType: mimeType || 'application/octet-stream',
    fileData,
    sentAt: new Date().toISOString()
  });
  await patchUser(found.userId, { documents, updatedAt: new Date().toISOString() });

  res.json({ success: true, documentsCount: documents.length });
});

// POST /api/check-subscription { telegramUserId } -> { isSubscribed }
app.post('/api/check-subscription', async (req, res) => {
  const { telegramUserId } = req.body || {};

  if (!telegramUserId) {
    return res.status(400).json({ isSubscribed: false, error: 'telegramUserId kerak' });
  }
  if (!BOT_TOKEN) {
    console.error("BOT_TOKEN muhit o'zgaruvchisi sozlanmagan!");
    return res.json({ isSubscribed: true });
  }

  try {
    const tgRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(CHANNEL_USERNAME)}&user_id=${telegramUserId}`
    );
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      return res.json({ isSubscribed: false });
    }

    const status = tgData.result.status;
    const isSubscribed = ['creator', 'administrator', 'member'].includes(status);
    return res.json({ isSubscribed });
  } catch (e) {
    console.error('Obunani tekshirishda xato:', e.message);
    return res.json({ isSubscribed: true });
  }
});

// ============================================================
// ONLAYN RAQIB (Real-time 1v1 Battle) — Firebase Realtime Database orqali
// ikkita haqiqiy foydalanuvchini navbat (queue) yordamida moslashtiradi
// va ularning javoblarini real vaqtda solishtiradi.
// ============================================================

// POST /api/battle/join { userId, nickname, questions } -> { matched, sessionId?, opponentNickname?, questions? }
app.post('/api/battle/join', async (req, res) => {
  const { userId, nickname, questions } = req.body || {};
  if (!userId || !nickname || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: "Noto'g'ri so'rov" });
  }

  const queueSnap = await rtdb.ref('battle_queue').once('value');
  const queue = queueSnap.val() || {};
  const now = Date.now();
  // Faqat so'nggi 60 soniya ichida navbatga qo'shilgan (hali "tirik") foydalanuvchilarni hisobga olamiz
  const waitingIds = Object.keys(queue).filter(
    uid => uid !== String(userId) && (now - (queue[uid].joinedAt || 0)) < 60000
  );

  if (waitingIds.length > 0) {
    const opponentId = waitingIds[0];
    const opponent = queue[opponentId];
    const sessionId = 'battle_' + now + '_' + Math.random().toString(36).slice(2, 8);

    await rtdb.ref('battle_sessions/' + sessionId).set({
      players: { [opponentId]: opponent.nickname, [String(userId)]: nickname },
      questions: opponent.questions, // birinchi kutgan o'yinchining savollari "rasmiy" hisoblanadi
      answers: {},
      createdAt: now
    });

    await rtdb.ref('battle_queue/' + opponentId).update({ matchedSessionId: sessionId });
    await rtdb.ref('battle_queue/' + userId).remove();

    return res.json({ matched: true, sessionId, opponentNickname: opponent.nickname, questions: opponent.questions });
  }

  await rtdb.ref('battle_queue/' + userId).set({ nickname, questions, joinedAt: now, matchedSessionId: null });
  res.json({ matched: false });
});

// GET /api/battle/queue-status?userId=... -> { matched, sessionId?, opponentNickname?, questions? }
app.get('/api/battle/queue-status', async (req, res) => {
  const { userId } = req.query || {};
  if (!userId) return res.status(400).json({ error: 'userId kerak' });

  const snap = await rtdb.ref('battle_queue/' + userId).once('value');
  const entry = snap.val();
  if (!entry) return res.json({ matched: false });

  if (entry.matchedSessionId) {
    const sessionSnap = await rtdb.ref('battle_sessions/' + entry.matchedSessionId).once('value');
    const session = sessionSnap.val();
    if (!session) return res.json({ matched: false });
    const opponentId = Object.keys(session.players).find(id => id !== String(userId));
    await rtdb.ref('battle_queue/' + userId).remove();
    return res.json({
      matched: true,
      sessionId: entry.matchedSessionId,
      opponentNickname: session.players[opponentId],
      questions: session.questions
    });
  }
  res.json({ matched: false });
});

// POST /api/battle/leave { userId } — qidiruvni bekor qilish
app.post('/api/battle/leave', async (req, res) => {
  const { userId } = req.body || {};
  if (userId) await rtdb.ref('battle_queue/' + userId).remove();
  res.json({ success: true });
});

// POST /api/battle/answer { sessionId, userId, qIndex, selected, correct }
app.post('/api/battle/answer', async (req, res) => {
  const { sessionId, userId, qIndex, selected, correct } = req.body || {};
  if (!sessionId || !userId || typeof qIndex !== 'number') {
    return res.status(400).json({ error: "Noto'g'ri so'rov" });
  }
  await rtdb.ref(`battle_sessions/${sessionId}/answers/${userId}/${qIndex}`).set({
    selected: typeof selected === 'number' ? selected : -1,
    correct: !!correct,
    at: Date.now()
  });
  res.json({ success: true });
});

// GET /api/battle/state?sessionId=... — raqibning javoblarini pollash uchun
app.get('/api/battle/state', async (req, res) => {
  const { sessionId } = req.query || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId kerak' });
  const snap = await rtdb.ref('battle_sessions/' + sessionId).once('value');
  const session = snap.val();
  if (!session) return res.status(404).json({ error: 'Sessiya topilmadi' });
  res.json({ answers: session.answers || {}, players: session.players });
});

// GET /api/leaderboard?region=...&district=...
app.get('/api/leaderboard', async (req, res) => {
  const { region, district } = req.query || {};
  const db = await loadDB();
  let list = Object.values(db).filter(u => !u.isAdmin);

  if (region) list = list.filter(u => u.region === region);
  if (district) list = list.filter(u => u.district === district);

  list = list
    .map(u => ({ nickname: u.nickname, atoms: u.atoms || 0, region: u.region || null, district: u.district || null }))
    .sort((a, b) => b.atoms - a.atoms)
    .slice(0, 50);

  res.json({ leaderboard: list });
});

app.listen(PORT, () => {
  console.log(`Atlas Kimyo backend server ${PORT}-portda ishga tushdi`);
});
