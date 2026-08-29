// Atlas Kimyo — Backend Server
// Vazifalari:
//  1) Nickname'larning HAQIQIY global yagonaligini tekshirish
//  2) Har bir foydalanuvchining Atom/Anti-modda balansini markazda saqlash
//     (shunda admin boshqa foydalanuvchiga haqiqatda atom bera oladi)
//  3) Admin panel uchun maxsus himoyalangan endpoint
//  4) Referal tizimi (yangi foydalanuvchi chaqirgan egasiga bonus atom berish)
//
// Ma'lumotlar oddiy JSON faylda saqlanadi (kichik/o'rta loyihalar uchun yetarli).

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'nicknames.json');

// Referal bonusi miqdori (har bir taklif qilingan do'st uchun atom)
const REFERRAL_BONUS = 50;

// Admin nickname va parol shu yerda belgilanadi (parolni env orqali ham berish mumkin)
const ADMIN_NICKNAME = '@atlas_ilmUSTOZ';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '22042000';

app.use(cors());
app.use(express.json({ limit: '15mb' })); // fayllar base64 sifatida yuborilgani uchun chegarani oshiramiz

// ---- Oddiy fayl-bazasi bilan ishlash ----
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({}, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
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

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// POST /api/check-nickname { nickname } -> { available }
app.post('/api/check-nickname', (req, res) => {
  const { nickname } = req.body || {};
  if (!nickname || !isValidNickname(nickname)) {
    return res.status(400).json({ error: "Noto'g'ri nickname formati" });
  }
  const db = loadDB();
  const found = findEntryByNickname(db, nickname);
  res.json({ available: !found });
});

// POST /api/register-nickname { nickname, password, userId, referrerId }
// Yangi profil — atom/anti-modda 0 dan boshlanadi (adolat uchun)
app.post('/api/register-nickname', (req, res) => {
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

  const db = loadDB();
  const existingByNick = findEntryByNickname(db, nickname);

  if (existingByNick && existingByNick.userId !== userId) {
    return res.json({ success: false, error: 'Nickname band' });
  }

  const isNewProfile = !db[userId] || db[userId].nickname.toLowerCase() !== nickname.toLowerCase();

  // REFERAL BONUS LOGIKASI (Faqat yangi profillar yaratilganda)
  if (isNewProfile && referrerId && String(referrerId) !== String(userId)) {
    // Referrer bazada haqiqatda mavjudligini tekshiramiz
    if (db[referrerId]) {
      db[referrerId].atoms = (db[referrerId].atoms || 0) + REFERRAL_BONUS;
      db[referrerId].updatedAt = new Date().toISOString();
    }
  }

  // Yangi profil uchun tiklash kodi generatsiya qilamiz (faqat shu javobda bir marta ko'rsatiladi)
  const recoveryCode = isNewProfile
    ? Math.floor(100000 + Math.random() * 900000).toString()
    : null;

  db[userId] = {
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
  saveDB(db);

  res.json({
    success: true,
    isAdmin: db[userId].isAdmin,
    atoms: db[userId].atoms,
    antiModda: db[userId].antiModda,
    unlockedFiles: db[userId].unlockedFiles,
    documents: db[userId].documents,
    recoveryCode // faqat ro'yxatdan o'tishda (yangi profilda) qaytariladi, keyin hech qachon qayta ko'rsatilmaydi
  });
});

// POST /api/login { nickname, password } -> { success, atoms, antiModda, isAdmin, unlockedFiles, documents }
// Boshqa qurilmadan kirganda yoki sahifa yangilanganda balansni qayta olish uchun
app.post('/api/login', (req, res) => {
  const { nickname, password } = req.body || {};
  if (!nickname || !password) {
    return res.status(400).json({ success: false, error: "Nickname va parol talab qilinadi" });
  }
  const db = loadDB();
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
// Parolni unutgan foydalanuvchi ro'yxatdan o'tishda olgan 6 xonali kod orqali tiklaydi
app.post('/api/recover-password', (req, res) => {
  const { nickname, recoveryCode, newPassword } = req.body || {};
  if (!nickname || !recoveryCode || !isValidPassword(newPassword)) {
    return res.status(400).json({ success: false, error: "Barcha maydonlarni to'g'ri to'ldiring (yangi parol 8 belgi)" });
  }
  const db = loadDB();
  const found = findEntryByNickname(db, nickname);
  if (!found || !found.entry.recoveryCodeHash || found.entry.recoveryCodeHash !== hashPassword(recoveryCode)) {
    return res.json({ success: false, error: "Nickname yoki tiklash kodi noto'g'ri" });
  }
  db[found.userId].passwordHash = hashPassword(newPassword);
  db[found.userId].updatedAt = new Date().toISOString();
  saveDB(db);
  res.json({ success: true, atoms: db[found.userId].atoms, antiModda: db[found.userId].antiModda, isAdmin: !!db[found.userId].isAdmin, unlockedFiles: db[found.userId].unlockedFiles || [], documents: db[found.userId].documents || [] });
});

// POST /api/sync-balance { nickname, password, atoms, antiModda }
// Ilova ichida atom/anti-modda o'zgargan sari serverga yuborib turiladi
app.post('/api/sync-balance', (req, res) => {
  const { nickname, password, atoms, antiModda, region, district } = req.body || {};
  if (!nickname || !password) {
    return res.status(400).json({ success: false, error: "Nickname va parol talab qilinadi" });
  }
  const db = loadDB();
  const found = findEntryByNickname(db, nickname);
  if (!found || found.entry.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ success: false, error: "Avtorizatsiya xato" });
  }

  db[found.userId].atoms = typeof atoms === 'number' ? atoms : found.entry.atoms;
  db[found.userId].antiModda = typeof antiModda === 'number' ? antiModda : found.entry.antiModda;
  if (region) db[found.userId].region = region;
  if (district) db[found.userId].district = district;
  db[found.userId].updatedAt = new Date().toISOString();
  saveDB(db);

  res.json({ success: true });
});

// POST /api/admin/grant { adminNickname, adminPassword, targetNickname, atoms, antiModda }
// Faqat admin nickname+parol to'g'ri bo'lsa ishlaydi. Ko'rsatilgan miqdorni maqsadli
// foydalanuvchi balansiga QO'SHADI (mavjud balansga ustiga).
app.post('/api/admin/grant', (req, res) => {
  const { adminNickname, adminPassword, targetNickname, atoms, antiModda } = req.body || {};

  if (!adminNickname || !isAdminNickname(adminNickname) || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: "Admin huquqi tasdiqlanmadi" });
  }
  if (!targetNickname || !isValidNickname(targetNickname)) {
    return res.status(400).json({ success: false, error: "Noto'g'ri maqsadli nickname" });
  }

  const db = loadDB();
  const found = findEntryByNickname(db, targetNickname);
  if (!found) {
    return res.status(404).json({ success: false, error: "Bunday nickname topilmadi" });
  }

  found.entry.atoms = (found.entry.atoms || 0) + (Number(atoms) || 0);
  found.entry.antiModda = (found.entry.antiModda || 0) + (Number(antiModda) || 0);
  found.entry.updatedAt = new Date().toISOString();
  db[found.userId] = found.entry;
  saveDB(db);

  res.json({ success: true, newAtoms: found.entry.atoms, newAntiModda: found.entry.antiModda });
});

// POST /api/admin/grant-file { adminNickname, adminPassword, targetNickname, fileId }
// Adminning istalgan foydalanuvchiga do'kondagi biror dasturni bepul ochib berishi
app.post('/api/admin/grant-file', (req, res) => {
  const { adminNickname, adminPassword, targetNickname, fileId } = req.body || {};

  if (!adminNickname || !isAdminNickname(adminNickname) || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: "Admin huquqi tasdiqlanmadi" });
  }
  if (!targetNickname || !isValidNickname(targetNickname) || !fileId) {
    return res.status(400).json({ success: false, error: "Noto'g'ri so'rov" });
  }

  const db = loadDB();
  const found = findEntryByNickname(db, targetNickname);
  if (!found) {
    return res.status(404).json({ success: false, error: "Bunday nickname topilmadi" });
  }

  if (!found.entry.unlockedFiles) found.entry.unlockedFiles = [];
  if (!found.entry.unlockedFiles.includes(fileId)) {
    found.entry.unlockedFiles.push(fileId);
  }
  found.entry.updatedAt = new Date().toISOString();
  db[found.userId] = found.entry;
  saveDB(db);

  res.json({ success: true, unlockedFiles: found.entry.unlockedFiles });
});

// POST /api/admin/send-document { adminNickname, adminPassword, targetNickname, fileName, mimeType, fileData }
// Adminning istalgan faylni (PDF, rasm, hujjat) aynan bitta foydalanuvchiga shaxsan yuborishi.
// fileData — base64 formatidagi fayl tarkibi (data URL prefiksisiz, faqat base64 qismi).
app.post('/api/admin/send-document', (req, res) => {
  const { adminNickname, adminPassword, targetNickname, fileName, mimeType, fileData } = req.body || {};

  if (!adminNickname || !isAdminNickname(adminNickname) || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: "Admin huquqi tasdiqlanmadi" });
  }
  if (!targetNickname || !isValidNickname(targetNickname) || !fileName || !fileData) {
    return res.status(400).json({ success: false, error: "Noto'g'ri so'rov — fayl va nickname talab qilinadi" });
  }
  // Taxminan 10MB dan katta fayllarni rad etamiz (base64 hajmi asl hajmdan ~1.37 marta katta bo'ladi)
  if (fileData.length > 14 * 1024 * 1024) {
    return res.status(413).json({ success: false, error: "Fayl juda katta (maksimal ~10MB)" });
  }

  const db = loadDB();
  const found = findEntryByNickname(db, targetNickname);
  if (!found) {
    return res.status(404).json({ success: false, error: "Bunday nickname topilmadi" });
  }

  if (!found.entry.documents) found.entry.documents = [];
  found.entry.documents.push({
    id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    fileName,
    mimeType: mimeType || 'application/octet-stream',
    fileData,
    sentAt: new Date().toISOString()
  });
  found.entry.updatedAt = new Date().toISOString();
  db[found.userId] = found.entry;
  saveDB(db);

  res.json({ success: true, documentsCount: found.entry.documents.length });
});

// GET /api/leaderboard?region=...&district=... — Top foydalanuvchilar (admin reytingda ko'rsatilmaydi)
// region/district berilsa, faqat o'sha hududdagi foydalanuvchilar ko'rsatiladi
app.get('/api/leaderboard', (req, res) => {
  const { region, district } = req.query || {};
  const db = loadDB();
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
