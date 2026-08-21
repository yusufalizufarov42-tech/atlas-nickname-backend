// Atlas Kimyo — Backend Server
// Vazifalari:
//  1) Nickname'larning HAQIQIY global yagonaligini tekshirish
//  2) Har bir foydalanuvchining Atom/Anti-modda balansini markazda saqlash
//     (shunda admin boshqa foydalanuvchiga haqiqatda atom bera oladi)
//  3) Admin panel uchun maxsus himoyalangan endpoint
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

// Admin nickname va parol shu yerda belgilanadi (parolni env orqali ham berish mumkin)
const ADMIN_NICKNAME = '@atlas_ilmUSTOZ';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '22042000yusuf';

app.use(cors());
app.use(express.json());

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

// POST /api/register-nickname { nickname, password, userId }
// Yangi profil — atom/anti-modda 0 dan boshlanadi (adolat uchun)
app.post('/api/register-nickname', (req, res) => {
  const { nickname, password, userId } = req.body || {};
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

  db[userId] = {
    nickname,
    passwordHash: hashPassword(password),
    // Yangi nickname (yoki yangi profil) — statistikalar 0 dan boshlanadi (adolat)
    atoms: isNewProfile ? 0 : (db[userId]?.atoms || 0),
    antiModda: isNewProfile ? 0 : (db[userId]?.antiModda || 0),
    isAdmin: isAdminNickname(nickname),
    updatedAt: new Date().toISOString()
  };
  saveDB(db);

  res.json({
    success: true,
    isAdmin: db[userId].isAdmin,
    atoms: db[userId].atoms,
    antiModda: db[userId].antiModda
  });
});

// POST /api/login { nickname, password } -> { success, atoms, antiModda, isAdmin }
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
    isAdmin: !!found.entry.isAdmin
  });
});

// POST /api/sync-balance { nickname, password, atoms, antiModda }
// Ilova ichida atom/anti-modda o'zgargan sari serverga yuborib turiladi
app.post('/api/sync-balance', (req, res) => {
  const { nickname, password, atoms, antiModda } = req.body || {};
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

// GET /api/leaderboard — Top foydalanuvchilar (admin reytingda ko'rsatilmaydi)
app.get('/api/leaderboard', (req, res) => {
  const db = loadDB();
  const list = Object.values(db)
    .filter(u => !u.isAdmin)
    .map(u => ({ nickname: u.nickname, atoms: u.atoms || 0 }))
    .sort((a, b) => b.atoms - a.atoms)
    .slice(0, 50);
  res.json({ leaderboard: list });
});

app.listen(PORT, () => {
  console.log(`Atlas Kimyo backend server ${PORT}-portda ishga tushdi`);
});
