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

// Bot backend'i (Python) bilan Node backend o'rtasidagi ichki chaqiruvlar uchun maxfiy kalit.
// Faqat botdan keladigan so'rovlarni (masalan /api/set-details) tekshirish uchun ishlatiladi —
// Mini App'dan to'g'ridan-to'g'ri kirish uchun EMAS. Render'da BOT_TOKEN kabi Environment
// bo'limiga INTERNAL_API_KEY nomi bilan qo'shing (ixtiyoriy tasodifiy matn, masalan 32 ta belgi).
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || null;
function checkInternalKey(req, res) {
  if (!INTERNAL_API_KEY) return true; // sozlanmagan bo'lsa — tekshiruvsiz o'tkazamiz (moslashuvchanlik uchun)
  if (req.headers['x-internal-key'] === INTERNAL_API_KEY) return true;
  res.status(401).json({ success: false, error: 'Ruxsat yo\'q' });
  return false;
}

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

// POST /api/profile { userId, referrerId?, firstName? }
// Ilova ochilganda ENG BIRINCHI chaqiriladi. Telegram ID (userId) bo'yicha profil
// bazada bo'lsa — o'sha profilni qaytaradi (login/ro'yxatdan o'tish ekrani KERAK EMAS).
// Bo'lmasa — bo'sh profil (nickname'siz, atom/anti-modda 0) avtomatik yaratiladi.
// Shunday qilib admin holati, atomlar va boshqa hammasi Telegram ID orqali saqlanadi;
// nickname/parol esa endi FAQAT ixtiyoriy — Profil bo'limida keyinroq qo'yiladi.
app.post('/api/profile', async (req, res) => {
  const { userId, referrerId, firstName } = req.body || {};
  if (!userId) return res.status(400).json({ success: false, error: 'userId talab qilinadi' });

  const db = await loadDB();
  let entry = db[userId];
  let isNewProfile = false;

  if (!entry) {
    isNewProfile = true;
    entry = {
      nickname: '', passwordHash: null, recoveryCodeHash: null,
      atoms: 0, antiModda: 0,
      referredBy: null, unlockedFiles: [], documents: [],
      isAdmin: false, telegramFirstName: firstName || null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    // Referal bonusi — faqat Telegram ID bo'yicha HAQIQIY birinchi marta kirganda beriladi
    if (referrerId && String(referrerId) !== String(userId) && db[referrerId]) {
      const newReferrerAtoms = (db[referrerId].atoms || 0) + REFERRAL_BONUS;
      await patchUser(referrerId, { atoms: newReferrerAtoms, updatedAt: new Date().toISOString() });
      entry.referredBy = referrerId;
    }
    await saveUser(userId, entry);
  } else if (firstName && entry.telegramFirstName !== firstName) {
    // Ism yangilanishini kuzatib boramiz (foydali — masalan nickname qo'yilmagan foydalanuvchilar uchun)
    await patchUser(userId, { telegramFirstName: firstName, updatedAt: new Date().toISOString() });
    entry.telegramFirstName = firstName;
  }

  res.json({
    success: true,
    isNewProfile,
    nickname: entry.nickname || '',
    hasNickname: !!entry.nickname,
    atoms: entry.atoms || 0,
    antiModda: entry.antiModda || 0,
    isAdmin: !!entry.isAdmin,
    unlockedFiles: entry.unlockedFiles || [],
    documents: entry.documents || [],
    region: entry.region || null,
    district: entry.district || null,
    phone: entry.phone || null,
    firstName: entry.telegramFirstName || null,
    fullName: entry.fullName || null,
    hasDetails: !!(entry.region && entry.district)
  });
});

// POST /api/set-details { userId, fullName, phone, region, district }
// Bot (Python) tomonidan chaqiriladi — ism-familiya, telefon, viloyat/tuman ENDI
// FAQAT bot orqali yig'iladi (Mini App'da bu maydonlar yo'q). Profil bo'lmasa
// avtomatik yaratiladi (atom/anti-modda/admin holatiga HECH TEGILMAYDI).
app.post('/api/set-details', async (req, res) => {
  if (!checkInternalKey(req, res)) return;
  const { userId, fullName, phone, region, district } = req.body || {};
  if (!userId) return res.status(400).json({ success: false, error: 'userId talab qilinadi' });

  const db = await loadDB();
  if (!db[userId]) {
    // Bot orqali birinchi marta kelgan foydalanuvchi uchun bo'sh profil yaratamiz
    // (xuddi /api/profile avtomatik yaratgani kabi)
    await saveUser(userId, {
      nickname: '', passwordHash: null, recoveryCodeHash: null,
      atoms: 0, antiModda: 0, referredBy: null, unlockedFiles: [], documents: [],
      isAdmin: false, telegramFirstName: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
  }

  const patch = { updatedAt: new Date().toISOString() };
  if (fullName) patch.fullName = fullName;
  if (phone) patch.phone = phone;
  if (region) patch.region = region;
  if (district) patch.district = district;
  await patchUser(userId, patch);

  res.json({ success: true });
});

// POST /api/link-account { userId, nickname, password }
// "Eski hisobni bog'lash": foydalanuvchi avval boshqa profilda (masalan eski qurilma/
// eski tizim davrida) qo'ygan nickname+parolini kiritadi. Topilsa va parol to'g'ri bo'lsa —
// o'sha eski profildagi atom/anti-modda/fayllar JORIY (Telegram ID'ga bog'langan) profilga
// QO'SHIB (ustidan yozmasdan) qo'yiladi, so'ng eski yozuv o'chiriladi (dublikat qolmasin).
app.post('/api/link-account', async (req, res) => {
  const { userId, nickname, password } = req.body || {};
  if (!userId) return res.status(400).json({ success: false, error: 'userId talab qilinadi' });
  if (!nickname || !password) return res.status(400).json({ success: false, error: "Nickname va parolni kiriting" });

  const db = await loadDB();
  const found = findEntryByNickname(db, nickname);
  if (!found || found.entry.passwordHash !== hashPassword(password)) {
    return res.json({ success: false, error: "Nickname yoki parol noto'g'ri" });
  }

  const cur = db[userId] || { atoms: 0, antiModda: 0, unlockedFiles: [], documents: [], isAdmin: false };

  if (found.userId === userId) {
    // Bu allaqachon joriy profilning o'zi — birlashtirishning hojati yo'q
    return res.json({
      success: true, merged: false,
      nickname: cur.nickname || '', atoms: cur.atoms || 0, antiModda: cur.antiModda || 0,
      isAdmin: !!cur.isAdmin, unlockedFiles: cur.unlockedFiles || [], documents: cur.documents || []
    });
  }

  const old = found.entry;
  const merged = {
    nickname: old.nickname,
    passwordHash: old.passwordHash,
    recoveryCodeHash: old.recoveryCodeHash || cur.recoveryCodeHash || null,
    atoms: (cur.atoms || 0) + (old.atoms || 0),
    antiModda: (cur.antiModda || 0) + (old.antiModda || 0),
    referredBy: cur.referredBy || old.referredBy || null,
    unlockedFiles: Array.from(new Set([...(cur.unlockedFiles || []), ...(old.unlockedFiles || [])])),
    documents: [...(cur.documents || []), ...(old.documents || [])],
    isAdmin: !!(cur.isAdmin || old.isAdmin),
    telegramFirstName: cur.telegramFirstName || null,
    region: cur.region || old.region || null,
    district: cur.district || old.district || null,
    phone: cur.phone || old.phone || null,
    updatedAt: new Date().toISOString()
  };
  await saveUser(userId, merged);
  await rtdb.ref('users/' + found.userId).remove(); // eski (endi bog'langan) yozuvni o'chiramiz — dublikat/eski reyting qolmasin

  res.json({
    success: true, merged: true,
    nickname: merged.nickname, atoms: merged.atoms, antiModda: merged.antiModda,
    isAdmin: merged.isAdmin, unlockedFiles: merged.unlockedFiles, documents: merged.documents
  });
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

  // MUHIM: "yangi profil"ligi FAQAT shu userId uchun umuman yozuv yo'qligiga qarab
  // aniqlanadi — avvalgi kod bu yerda nickname farq qilsa ham "yangi" deb hisoblab,
  // Telegram ID orqali allaqachon to'plangan atomlarni 0 ga tushirib yuborardi.
  const isNewProfile = !db[userId];

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

// POST /api/change-nickname { currentNickname, currentPassword, newNickname, newPassword }
// Foydalanuvchi Profil bo'limidan o'z nickname/parolini o'zgartiradi.
// MUHIM: atoms/antiModda/unlockedFiles/documents/referredBy — HAMMASI saqlanib qoladi,
// faqat nickname va parol yangilanadi (progress yo'qolmaydi).
app.post('/api/change-nickname', async (req, res) => {
  const { currentNickname, currentPassword, newNickname, newPassword } = req.body || {};
  if (!currentNickname || !currentPassword) {
    return res.status(400).json({ success: false, error: 'Joriy nickname va parol talab qilinadi' });
  }
  if (!isValidNickname(newNickname)) {
    return res.status(400).json({ success: false, error: "Yangi nickname formati noto'g'ri" });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ success: false, error: "Yangi parol aniq 8 ta belgidan iborat bo'lishi kerak" });
  }

  const db = await loadDB();
  const found = findEntryByNickname(db, currentNickname);
  if (!found || found.entry.passwordHash !== hashPassword(currentPassword)) {
    return res.status(401).json({ success: false, error: "Joriy nickname yoki parol noto'g'ri" });
  }

  // Yangi nickname band emasligini tekshiramiz (agar u o'zgargan bo'lsa)
  if (newNickname.toLowerCase() !== currentNickname.toLowerCase()) {
    const existing = findEntryByNickname(db, newNickname);
    if (existing && existing.userId !== found.userId) {
      return res.json({ success: false, error: 'Bu nickname band' });
    }
  }

  await patchUser(found.userId, {
    nickname: newNickname,
    passwordHash: hashPassword(newPassword),
    updatedAt: new Date().toISOString()
  });

  res.json({
    success: true,
    atoms: found.entry.atoms,
    antiModda: found.entry.antiModda,
    isAdmin: !!found.entry.isAdmin,
    unlockedFiles: found.entry.unlockedFiles || [],
    documents: found.entry.documents || []
  });
});

// POST /api/sync-balance-uid { userId, atoms, antiModda, region, district }
// nickname/parol hali qo'yilmagan foydalanuvchilar uchun ham ishlaydigan sinxronizatsiya
// (Telegram ID orqali) — /api/sync-balance bilan bir xil, faqat nickname/parol shart emas.
app.post('/api/sync-balance-uid', async (req, res) => {
  const { userId, atoms, antiModda, region, district } = req.body || {};
  if (!userId) return res.status(400).json({ success: false, error: 'userId talab qilinadi' });
  const db = await loadDB();
  if (!db[userId]) return res.status(404).json({ success: false, error: 'Profil topilmadi' });

  const patch = { updatedAt: new Date().toISOString() };
  if (typeof atoms === 'number') patch.atoms = atoms;
  if (typeof antiModda === 'number') patch.antiModda = antiModda;
  if (region) patch.region = region;
  if (district) patch.district = district;
  await patchUser(userId, patch);

  res.json({ success: true });
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
// POST /api/battle/join { userId, nickname, questions } -> { matched, sessionId?, opponentNickname?, questions? }
// MUHIM: bir vaqtda kelgan ikkita so'rov orasidagi "poyga holati"ni (race condition)
// oldini olish uchun Firebase TRANZAKSIYASI ishlatiladi — faqat BITTA foydalanuvchi
// navbatdagi "kutayotgan o'rin"ni band qilishi mumkin, boshqasi shu bilan avtomatik moslashadi.
app.post('/api/battle/join', async (req, res) => {
  const { userId, nickname, questions } = req.body || {};
  if (!userId || !nickname || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: "Noto'g'ri so'rov" });
  }

  const waitingRef = rtdb.ref('battle_waiting_player');
  let matchedOpponent = null;

  const txResult = await waitingRef.transaction((current) => {
    const now = Date.now();
    if (current && String(current.userId) === String(userId)) {
      return current; // biz allaqachon kutyapmiz — o'zgarishsiz qoldiramiz
    }
    if (current && (now - (current.joinedAt || 0)) < 60000) {
      matchedOpponent = current; // kimdir (biz emas) kutyapti — moslashamiz
      return null; // navbatni bo'shatamiz
    }
    return { userId: String(userId), nickname, questions, joinedAt: now }; // hech kim yo'q — o'zimiz kutamiz
  });

  if (!txResult.committed) {
    return res.status(500).json({ error: "Navbatga qo'shilishda xato" });
  }

  if (matchedOpponent) {
    const sessionId = 'battle_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await rtdb.ref('battle_sessions/' + sessionId).set({
      players: { [matchedOpponent.userId]: matchedOpponent.nickname, [String(userId)]: nickname },
      questions: matchedOpponent.questions,
      answers: {},
      createdAt: Date.now()
    });
    // Kutayotgan (endi topilgan) o'yinchiga xabar qoldiramiz — u keyingi pollingda ko'radi
    await rtdb.ref('battle_matches/' + matchedOpponent.userId).set({
      sessionId, opponentNickname: nickname, questions: matchedOpponent.questions
    });
    return res.json({ matched: true, sessionId, opponentNickname: matchedOpponent.nickname, questions: matchedOpponent.questions });
  }

  res.json({ matched: false });
});

// GET /api/battle/queue-status?userId=... -> { matched, sessionId?, opponentNickname?, questions? }
app.get('/api/battle/queue-status', async (req, res) => {
  const { userId } = req.query || {};
  if (!userId) return res.status(400).json({ error: 'userId kerak' });

  const snap = await rtdb.ref('battle_matches/' + userId).once('value');
  const match = snap.val();
  if (!match) return res.json({ matched: false });

  await rtdb.ref('battle_matches/' + userId).remove();
  res.json({ matched: true, sessionId: match.sessionId, opponentNickname: match.opponentNickname, questions: match.questions });
});

// POST /api/battle/leave { userId } — qidiruvni bekor qilish
app.post('/api/battle/leave', async (req, res) => {
  const { userId } = req.body || {};
  if (userId) {
    await rtdb.ref('battle_waiting_player').transaction((current) => {
      if (current && String(current.userId) === String(userId)) return null;
      return current;
    });
    await rtdb.ref('battle_matches/' + userId).remove();
  }
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

// ============================================================
// DO'KON MAHSULOTLARI — endi Firebase'da saqlanadi, admin ularni
// dastur kodiga tegmasdan (Mini App'ning o'zidan) boshqarishi mumkin.
// ============================================================
const DEFAULT_SHOP_PRODUCTS = [
  { id: 'muvozanat', title: "⚖️ Atlas Ilm — Muvozanat va Reaksiya tezligi", desc: "8 bo'lim, 240 ta savol, streak tizimi va to'liq nazariya", price: 250, file: 'https://atlasilm-muvozanatvareaksiyatezligi.netlify.app/' },
  { id: 'oleum', title: '🧪 Atlas Ilm — Oleum Platformasi', desc: 'Murakkab oleum masalalari va platformasi', price: 250, file: 'https://atlasilm-oleum.netlify.app/' },
  { id: 'yadro', title: '⚛️ Atlas Ilm — Yadroviy Reaksiyalar', desc: 'Yadroviy kimyo, reaksiyalar va masalalar', price: 225, file: 'https://atlasilm-yadroviyreaksiyalar.netlify.app/' },
  { id: 'eritmalar', title: "🧪 Atlas Ilm — Eritmalar (To'liq nazariya)", desc: "Eritmalar mavzusidagi 15 bo'limli dastur", price: 225, file: 'https://atlasilm-eritmalar.netlify.app/' },
  { id: 'elektroliz', title: '⚡ Atlas Ilm — Elektroliz', desc: 'Elektroliz jarayonlari va hisob-kitoblar', price: 200, file: 'https://elaborate-kitsune-18d01a.netlify.app/' },
  { id: 'ph_tuz', title: '🧪 Atlas Ilm — pH va Tuz Gidrolizi', desc: 'pH qiymatlari va gidroliz reaksiyalari', price: 200, file: 'https://atlasilm-phvatuzgidrolizi.netlify.app/' },
  { id: 'gaz', title: '🎈 Atlas Ilm — Gaz Qonunlari', desc: "Gaz qonunlari bo'yicha 6 bo'limli dastur", price: 175, file: 'https://atlasilm-gazqonunlari.netlify.app/' },
  { id: 'kislota', title: '🧪 Atlas Ilm — Kislotalar', desc: 'Kislotalarning kimyoviy xossalari va testlar', price: 175, file: 'https://atlasilm-kislota.netlify.app/' },
  { id: 'oksid', title: '🔥 Atlas Ilm — Oksidlar', desc: 'Oksidlarga oid nazariya va testlar', price: 150, file: 'https://atlasilm-oksid.netlify.app/' },
  { id: 'asos', title: '🧼 Atlas Ilm — Asoslar', desc: 'Asoslar va ishqorlar mavzusidagi ilova', price: 150, file: 'https://atlasilm-asoslar.netlify.app/' },
  { id: 'tuzlar', title: '🧂 Atlas Ilm — Tuzlar Quiz', desc: 'Tuzlar mavzusidagi interaktiv testlar', price: 150, file: 'http://incandescent-axolotl-e71fcf.netlify.app/' }
];

// GET /api/shop/products -> { products: [...] }
// Firebase'da mahsulot bo'lmasa, standart ro'yxatni QAYTARADI VA SHU BILAN BIRGA
// bazaga yozib qo'yadi (birinchi chaqiriqda "urug'lantirish").
app.get('/api/shop/products', async (req, res) => {
  const snap = await rtdb.ref('shop_products').once('value');
  let products = snap.val();
  if (!products) {
    const seeded = {};
    DEFAULT_SHOP_PRODUCTS.forEach(p => { seeded[p.id] = p; });
    await rtdb.ref('shop_products').set(seeded);
    products = seeded;
  }
  res.json({ products: Object.values(products) });
});

// POST /api/admin/shop/upsert-product { adminNickname, adminPassword, id, title, desc, price, file }
// Mahsulot yaratish YOKI (agar id mavjud bo'lsa) yangilash — narx, nom, tavsif, havola.
app.post('/api/admin/shop/upsert-product', async (req, res) => {
  const { adminNickname, adminPassword, id, title, desc, price, file } = req.body || {};

  if (!adminNickname || !isAdminNickname(adminNickname) || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: "Admin huquqi tasdiqlanmadi" });
  }
  if (!id || !/^[a-zA-Z0-9_-]{2,40}$/.test(id)) {
    return res.status(400).json({ success: false, error: "Mahsulot ID'si noto'g'ri (faqat harf/raqam/tire, 2-40 belgi)" });
  }
  if (!title || !desc || !file || typeof price !== 'number' || price < 0) {
    return res.status(400).json({ success: false, error: "Barcha maydonlar (nom, tavsif, narx, havola) to'ldirilishi shart" });
  }

  await rtdb.ref('shop_products/' + id).set({ id, title, desc, price, file });
  const snap = await rtdb.ref('shop_products').once('value');
  res.json({ success: true, products: Object.values(snap.val() || {}) });
});

// POST /api/admin/shop/delete-product { adminNickname, adminPassword, id }
app.post('/api/admin/shop/delete-product', async (req, res) => {
  const { adminNickname, adminPassword, id } = req.body || {};
  if (!adminNickname || !isAdminNickname(adminNickname) || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: "Admin huquqi tasdiqlanmadi" });
  }
  if (!id) return res.status(400).json({ success: false, error: 'id kerak' });
  await rtdb.ref('shop_products/' + id).remove();
  const snap = await rtdb.ref('shop_products').once('value');
  res.json({ success: true, products: Object.values(snap.val() || {}) });
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

// ---- Testlar moduli (43 talik Rasch mock + javobli testlar) ----
// Fayllar: tests.js (backend) va tests.html (Mini App sahifasi, /tests manzilida ochiladi)
require('./tests')(app, { rtdb, BOT_TOKEN });

app.listen(PORT, () => {
  console.log(`Atlas Kimyo backend server ${PORT}-portda ishga tushdi`);
});
