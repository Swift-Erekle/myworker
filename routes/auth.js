// routes/auth.js
// BUG FIX (DeepSeek):
// 1. global.verifyCodes map — lost on restart, no TTL cleanup → replaced with DB table (VerifyCode)
// 2. Missing emailVerifyTemplate import
// 3. No input validation
// 4. Missing rate limiting

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const prisma = require('../utils/prisma');
const { sendEmail, emailVerifyTemplate, passwordResetTemplate } = require('../utils/email');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { error: 'ძალიან ბევრი მცდელობა. 15 წუთში ისევ სცადე.' },
});
const codeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 3,
  message: { error: 'ძალიან ბევრი კოდის გაგზავნა. 1 წუთში ისევ სცადე.' },
});

// ── Helpers ────────────────────────────────────────────────────────

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function signToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function safeUser(u) {
  const { password, ...rest } = u;
  return rest;
}

async function saveCode(email, code, type) {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
  await prisma.verifyCode.upsert({
    where: { email },
    update: { code, type, expiresAt },
    create: { email, code, type, expiresAt },
  });
}

async function checkCode(email, code, type) {
  const record = await prisma.verifyCode.findUnique({ where: { email } });
  if (!record) return false;
  if (record.type !== type) return false;
  if (record.code !== code) return false;
  if (record.expiresAt < new Date()) return false;
  // Delete after use
  await prisma.verifyCode.delete({ where: { email } });
  return true;
}

// ── Routes ─────────────────────────────────────────────────────────

// POST /api/auth/register
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { name, surname, email, password, phone, type, specialty, desc } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: 'სახელი, ელ-ფოსტა და პაროლი სავალდებულოა' });
    if (password.length < 8)
      return res.status(400).json({ error: 'პაროლი მინიმუმ 8 სიმბოლო' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'ელ-ფოსტა არასწორია' });

    const userType = ['user', 'handyman', 'company'].includes(type) ? type : 'user';
    if ((userType === 'handyman' || userType === 'company') && !specialty)
      return res.status(400).json({ error: 'სპეციალობა სავალდებულოა ხელოსნებისთვის' });

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: 'ეს ელ-ფოსტა უკვე გამოყენებულია' });

    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        surname: (surname || '').trim(),
        email: email.toLowerCase().trim(),
        phone: (phone || '').trim() || null,
        password: hashed,
        type: userType,
        specialty: specialty || null,
        desc: desc || null,
        emoji: userType === 'company' ? '🏢' : userType === 'handyman' ? '🔧' : '👤',
        color: '#22222f',
      },
    });

    // Send email verification code
    const code = generateCode();
    await saveCode(email, code, 'verify');
    await sendEmail(email, 'ხელოსანი.ge — ვერიფიკაციის კოდი', emailVerifyTemplate(name, code));

    res.status(201).json({ userId: user.id, message: 'კოდი გაიგზავნა ელ-ფოსტაზე' });
  } catch (err) {
    console.error('[AUTH] register error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/auth/verify
router.post('/verify', codeLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'ელ-ფოსტა და კოდი სავალდებულოა' });

    const valid = await checkCode(email.toLowerCase(), code, 'verify');
    if (!valid) return res.status(400).json({ error: 'კოდი არასწორია ან ვადა გასულია' });

    const user = await prisma.user.update({
      where: { email: email.toLowerCase() },
      data: { emailVerified: true, verified: true },
    });
    const token = signToken(user.id);
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('[AUTH] verify error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/auth/resend
router.post('/resend', codeLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email?.toLowerCase() } });
    if (!user) return res.status(404).json({ error: 'მომხმარებელი ვერ მოიძებნა' });
    if (user.emailVerified) return res.status(400).json({ error: 'ელ-ფოსტა უკვე დადასტურებულია' });
    const code = generateCode();
    await saveCode(email.toLowerCase(), code, 'verify');
    await sendEmail(email, 'ხელოსანი.ge — ვერიფიკაციის კოდი', emailVerifyTemplate(user.name, code));
    res.json({ message: 'კოდი ხელახლა გაიგზავნა' });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'ელ-ფოსტა და პაროლი სავალდებულოა' });

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user) return res.status(401).json({ error: 'ელ-ფოსტა ან პაროლი არასწორია' });
    if (user.blocked) return res.status(403).json({ error: 'ანგარიში დაბლოკილია. support@xelosani.ge' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'ელ-ფოსტა ან პაროლი არასწორია' });

    const token = signToken(user.id);
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error('[AUTH] login error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/auth/forgot
router.post('/forgot', codeLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email: email?.toLowerCase()?.trim() } });
    // Always return OK to prevent email enumeration
    if (!user) return res.json({ message: 'კოდი გაიგზავნა (თუ ანგარიში არსებობს)' });

    const code = generateCode();
    await saveCode(email.toLowerCase(), code, 'reset');
    await sendEmail(email, 'ხელოსანი.ge — პაროლის აღდგენა', passwordResetTemplate(user.name, code));
    res.json({ message: 'კოდი გაიგზავნა ელ-ფოსტაზე' });
  } catch (err) {
    console.error('[AUTH] forgot error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/auth/reset
router.post('/reset', codeLimiter, async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword)
      return res.status(400).json({ error: 'ყველა ველი სავალდებულოა' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'პაროლი მინიმუმ 8 სიმბოლო' });

    const valid = await checkCode(email.toLowerCase(), code, 'reset');
    if (!valid) return res.status(400).json({ error: 'კოდი არასწორია ან ვადა გასულია' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { email: email.toLowerCase() },
      data: { password: hashed },
    });
    res.json({ message: 'პაროლი შეიცვალა' });
  } catch (err) {
    console.error('[AUTH] reset error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json(safeUser(req.user));
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'ყველა ველი სავალდებულოა' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'ახალი პაროლი მინიმუმ 8 სიმბოლო' });

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ error: 'მიმდინარე პაროლი არასწორია' });

    const hashed = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user.id }, data: { password: hashed } });
    res.json({ message: 'პაროლი შეიცვალა' });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
