// Ta'lim muassasalari moduli (1-bosqich): rol (o'quvchi/ustoz) va muassasa.
// Ro'yxat BO'SH boshlanadi — foydalanuvchilar o'zi yozadi; "45-maktab" / "45 maktab" /
// "45-sonli maktab" kabi yozilishlar AVTOMATIK bitta muassasaga birlashtiriladi.
//
// RTDB: institutions/{id} = { name, type, region, district, createdAt, createdBy }
//       users/{id}.role ('student'|'teacher'), .instId, .instName, .instType, .subject
//
// Endpointlar (faqat botdan, X-Internal-Key bilan):
//   POST /api/inst/list { region, district, type }  -> { items:[{id,name,count}] }
//   POST /api/inst/set  { userId, role, subject?, type?, instId?, name?, region?, district?, skip? }
//   POST /api/inst/preview { type, name, region, district } -> { name, existing:{id,name}|null }

const TYPES = {
  maktab:    { label: 'Maktab',          scope: 'district', numbered: true,  word: 'maktab' },
  litsey:    { label: 'Litsey',          scope: 'district', numbered: true,  word: 'litsey' },
  kollej:    { label: 'Kollej / texnikum', scope: 'district', numbered: true, word: 'kollej' },
  universitet: { label: 'Universitet / institut', scope: 'global', numbered: false, word: 'universitet' },
  markaz:    { label: "O'quv markazi",   scope: 'district', numbered: false, word: "o'quv markazi" },
};
const SUBJECTS = ['Kimyo', 'Biologiya', 'Matematika', 'Fizika', 'Ona tili', 'Ingliz tili', 'Tarix', 'Boshqa'];

// Turni bildiradigan so'zlar — nomdan olib tashlanadi (qaytadan qo'shiladi)
const TYPE_WORDS = [
  "umumiy o'rta ta'lim maktabi", "umumiy o'rta ta'lim", "ixtisoslashtirilgan maktab", "ixtisoslashtirilgan",
  'presidential', 'prezident', 'davlat umumta\'lim maktabi', 'umumta\'lim', 'idum', 'dti', 'maktabi', 'maktab',
  'litseyi', 'litsey', 'kolleji', 'kollej', 'texnikumi', 'texnikum', 'akademik litsey',
  'universiteti', 'universitet', 'instituti', 'institut', "o'quv markazi", "o'quv markaz", 'markazi', 'markaz',
  'sonli', 'son', 'raqamli', 'nomli',
].sort((a, b) => b.length - a.length);
function stripWords(s) {
  s = s.replace(/[№#]/g, ' ');
  TYPE_WORDS.forEach(w => {
    const re = new RegExp('(^|[\\s-])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s-])', 'g');
    s = s.replace(re, ' ');
  });
  return s;
}

function cleanApos(s) {
  return String(s || '').replace(/[ʻʼ’‘`´′]/g, "'");
}
function titleCase(s) {
  return s.split(' ').filter(Boolean).map(w => {
    if (/^[a-z]{2,5}$/i.test(w) && w === w.toUpperCase() && w.length > 1) return w; // TATU, SamDU...
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]/g, '');
}
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Xavfsizlik: aloqa/havola/telefon yozishni taqiqlaymiz (bola xavfsizligi)
function validateRaw(raw) {
  const s = cleanApos(raw).trim();
  if (s.length < 1 || s.length > 60) return "Nom 1–60 ta belgidan iborat bo'lsin.";
  if (/https?:|www\.|t\.me|\.(com|uz|org|ru)\b|@/i.test(s)) return "Nomda havola yoki @username bo'lmasin.";
  if ((s.match(/\d/g) || []).length > 4) return "Nom to'g'ri ko'rinmayapti (raqamlar ko'p).";
  if (!/[a-z0-9Ѐ-ӿ]/i.test(s)) return "Nom harf yoki raqamdan iborat bo'lsin.";
  return null;
}

// Nomni normallashtirish -> { name, key }
function normalize(type, raw) {
  const t = TYPES[type];
  if (!t) return null;
  let s = cleanApos(raw).toLowerCase().replace(/[“”"«»()]/g, ' ').replace(/[_,.;:!?]+/g, ' ');
  s = s.replace(/(\d)([a-z'])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  if (t.numbered) {
    const m = s.match(/\d+/);
    if (m) {
      const num = String(parseInt(m[0], 10));
      // raqamdan boshqa ma'noli so'z bormi? (masalan "3-litsey Navoiy nomidagi") — oddiy holat: faqat raqam
      // Raqamli muassasalar tumanda raqami bilan yagona — qo'shimcha so'zlar e'tiborga olinmaydi
      return { name: `${num}-${t.word.split(' ')[0]}`, key: `${type}:${num}` };
    }
  }
  let rest = s;
  rest = stripWords(rest);
  rest = rest.replace(/[-–—\s]+/g, ' ').trim();
  if (!rest) rest = s.replace(/[-–—\s]+/g, ' ').trim();
  let name;
  if (type === 'universitet') {
    name = (rest.length <= 6 && !/\s/.test(rest)) ? rest.toUpperCase() : titleCase(rest) + ' universiteti';
  } else if (type === 'markaz') {
    name = titleCase(rest) + " o'quv markazi";
  } else {
    name = titleCase(rest) + (type === 'kollej' ? ' kolleji' : type === 'litsey' ? ' litseyi' : ' maktabi');
  }
  return { name, key: `${type}:${slug(rest)}` };
}

module.exports = function (app, { rtdb, loadDB, checkInternalKey }) {
  const sameScope = (inst, type, region, district) => {
    if (inst.type !== type) return false;
    const sc = TYPES[type].scope;
    if (sc === 'global') return true;
    return inst.region === region && inst.district === district;
  };

  async function findExisting(type, region, district, norm) {
    const snap = await rtdb.ref('institutions').once('value');
    const all = snap.val() || {};
    let best = null;
    for (const [id, inst] of Object.entries(all)) {
      if (!sameScope(inst, type, region, district)) continue;
      if (inst.key === norm.key) return { id, ...inst };
      // yaqin yozilish (1 ta harf xato) — faqat nomli turlar uchun, raqamli maktablar aralashmasin
      // Faqat NOM qismi solishtiriladi ("tur:" prefiksi emas) va faqat uzun nomlar (>=8 belgi) —
      // aks holda TATU/TDTU, SamDU/SamDI kabi turli muassasalar bitta bo'lib qolardi.
      const numbered = TYPES[type].numbered && /\d/.test(norm.key);
      const a = String(inst.key || '').split(':').slice(1).join(':'), b = norm.key.split(':').slice(1).join(':');
      if (!numbered && b.length >= 8 && a.length >= 8 && lev(a, b) <= 1) best = best || { id, ...inst };
    }
    return best;
  }

  app.post('/api/inst/list', async (req, res) => {
    if (!checkInternalKey(req, res)) return;
    try {
      const { region, district, type } = req.body || {};
      if (!TYPES[type]) return res.status(400).json({ success: false, error: "Tur noto'g'ri" });
      const [snap, db] = await Promise.all([rtdb.ref('institutions').once('value'), loadDB()]);
      const all = snap.val() || {};
      const counts = {};
      Object.values(db).forEach(u => { if (u && u.instId) counts[u.instId] = (counts[u.instId] || 0) + 1; });
      const items = Object.entries(all)
        .filter(([, i]) => sameScope(i, type, region, district))
        .map(([id, i]) => ({ id, name: i.name, count: counts[id] || 0 }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 30);
      res.json({ success: true, items });
    } catch (e) { console.error('/api/inst/list', e); res.status(500).json({ success: false, error: 'Server xatosi' }); }
  });

  app.post('/api/inst/preview', async (req, res) => {
    if (!checkInternalKey(req, res)) return;
    try {
      const { type, name, region, district } = req.body || {};
      if (!TYPES[type]) return res.status(400).json({ success: false, error: "Tur noto'g'ri" });
      const bad = validateRaw(name);
      if (bad) return res.status(400).json({ success: false, error: bad });
      const norm = normalize(type, name);
      const ex = await findExisting(type, region, district, norm);
      res.json({ success: true, name: ex ? ex.name : norm.name, existing: ex ? { id: ex.id, name: ex.name } : null });
    } catch (e) { console.error('/api/inst/preview', e); res.status(500).json({ success: false, error: 'Server xatosi' }); }
  });

  app.post('/api/inst/set', async (req, res) => {
    if (!checkInternalKey(req, res)) return;
    try {
      const { userId, role, subject, type, instId, name, skip } = req.body || {};
      if (!userId) return res.status(400).json({ success: false, error: 'userId talab qilinadi' });
      if (role !== 'student' && role !== 'teacher') return res.status(400).json({ success: false, error: "Rol noto'g'ri" });
      const uref = rtdb.ref('users/' + userId);
      const u = (await uref.once('value')).val();
      if (!u) return res.status(404).json({ success: false, error: 'Profil topilmadi' });
      const region = req.body.region || u.region || '';
      const district = req.body.district || u.district || '';
      const patch = { role, updatedAt: new Date().toISOString() };
      patch.subject = role === 'teacher' && SUBJECTS.includes(subject) ? subject : null;

      if (skip) {
        patch.instId = null; patch.instName = null; patch.instType = null;
      } else if (instId) {
        const inst = (await rtdb.ref('institutions/' + instId).once('value')).val();
        if (!inst) return res.status(404).json({ success: false, error: 'Muassasa topilmadi' });
        patch.instId = instId; patch.instName = inst.name; patch.instType = inst.type;
      } else {
        if (!TYPES[type]) return res.status(400).json({ success: false, error: "Tur noto'g'ri" });
        const bad = validateRaw(name);
        if (bad) return res.status(400).json({ success: false, error: bad });
        const norm = normalize(type, name);
        let ex = await findExisting(type, region, district, norm);
        let id, finalName, merged = false;
        if (ex) { id = ex.id; finalName = ex.name; merged = true; }
        else {
          const ref = rtdb.ref('institutions').push();
          id = ref.key; finalName = norm.name;
          await ref.set({ name: norm.name, key: norm.key, type, region, district, createdAt: new Date().toISOString(), createdBy: String(userId) });
        }
        patch.instId = id; patch.instName = finalName; patch.instType = type;
        await uref.update(patch);
        return res.json({ success: true, instName: finalName, merged });
      }
      await uref.update(patch);
      res.json({ success: true, instName: patch.instName || null, merged: false });
    } catch (e) { console.error('/api/inst/set', e); res.status(500).json({ success: false, error: 'Server xatosi' }); }
  });

  app.locals.instNormalize = normalize;
};

module.exports.normalize = normalize;
module.exports.TYPES = TYPES;
