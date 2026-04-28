// routes/users.js
// ════════════════════════════════════════════════════════════════
// Changes:
// 1. getPlanWeight() — TOP plan users sort ABOVE VIP+ (weight=3)
// 2. Multi-specialty filtering via specialties[] array
// 3. /me route registered BEFORE /:id to avoid clash
// ✅ NEW: whatsappEnabled support (PATCH /me + GET /handymen + GET /:id)
// ════════════════════════════════════════════════════════════════
const express = require('express');
const prisma  = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { upload, handleCloudinaryUpload } = require('../middleware/upload');
const { deleteFile, uploadBuffer } = require('../utils/cloudinary');

const router = express.Router();

function safeUser(u) {
  const { password, ...rest } = u;
  return rest;
}

function vipActive(user) {
  if (!user.vipType || user.vipType === 'none') return false;
  return user.vipExpiresAt && new Date(user.vipExpiresAt) > new Date();
}

function planActive(user) {
  if (!user.plan || user.plan === 'start') return false;
  if (!user.planExpiresAt) return false;
  return new Date(user.planExpiresAt) > new Date();
}

function getSortWeight(user) {
  if (user.plan === 'top' && planActive(user)) return 3;
  if (vipActive(user) && user.vipType === 'vipp') return 2;
  if (vipActive(user) && user.vipType === 'vip') return 1;
  return 0;
}

function buildHandymanWhere(query) {
  const where = { type: { in: ['handyman', 'company'] }, blocked: false };

  if (query.specialty) {
    where.OR = [
      { specialty:   { contains: query.specialty,   mode: 'insensitive' } },
      { specialties: { has:      query.specialty } },
    ];
  }
  if (query.city) where.city = { contains: query.city, mode: 'insensitive' };
  if (query.q) {
    where.OR = [
      { name:      { contains: query.q, mode: 'insensitive' } },
      { surname:   { contains: query.q, mode: 'insensitive' } },
      { specialty: { contains: query.q, mode: 'insensitive' } },
    ];
  }
  return where;
}

router.get('/handymen', async (req, res) => {
  try {
    const where    = buildHandymanWhere(req.query);
    const handymen = await prisma.user.findMany({
      where,
      select: {
        id: true, name: true, surname: true, type: true,
        specialty: true, specialties: true,
        city: true, desc: true, services: true,
        emoji: true, color: true, avatar: true,
        verified: true, jobs: true,
        phone: true,
        whatsappEnabled: true,        // ✅ NEW
        vipType: true, vipExpiresAt: true, vipActivatedAt: true,
        plan: true, planExpiresAt: true,
        portfolio: true, createdAt: true,
        reviewsReceived: { select: { stars: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const minRating = parseFloat(req.query.minRating);
    let result = handymen;
    if (minRating > 0) {
      result = handymen.filter((h) => {
        if (!h.reviewsReceived.length) return false;
        const avg = h.reviewsReceived.reduce((s, r) => s + r.stars, 0) / h.reviewsReceived.length;
        return avg >= minRating;
      });
    }

    result.sort((a, b) => {
      const wa = getSortWeight(a);
      const wb = getSortWeight(b);
      if (wa !== wb) return wb - wa;
      if (wa > 0 && wb > 0) {
        const ta = a.vipActivatedAt  ? new Date(a.vipActivatedAt).getTime()
                 : a.planExpiresAt   ? new Date(a.planExpiresAt).getTime()  : 0;
        const tb = b.vipActivatedAt  ? new Date(b.vipActivatedAt).getTime()
                 : b.planExpiresAt   ? new Date(b.planExpiresAt).getTime()  : 0;
        if (ta !== tb) return tb - ta;
      }
      const ra = a.reviewsReceived.length
        ? a.reviewsReceived.reduce((s, r) => s + r.stars, 0) / a.reviewsReceived.length : 0;
      const rb = b.reviewsReceived.length
        ? b.reviewsReceived.reduce((s, r) => s + r.stars, 0) / b.reviewsReceived.length : 0;
      return rb - ra;
    });

    res.json(result);
  } catch (err) {
    console.error('[USERS] handymen error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

router.patch('/me', requireAuth, async (req, res) => {
  try {
    const {
      name, surname, phone, specialty, specialties, desc, services, city, emoji,
      whatsappEnabled,
    } = req.body;
    const data = {};
    if (name      !== undefined) data.name    = String(name).trim();
    if (surname   !== undefined) data.surname  = String(surname).trim();
    if (phone     !== undefined) data.phone    = phone || null;
    if (desc      !== undefined) data.desc     = desc  || null;
    if (city      !== undefined) data.city     = city  || null;
    if (emoji     !== undefined) data.emoji    = emoji || '🔧';

    // ✅ NEW: only handymen/companies can enable WhatsApp
    if (whatsappEnabled !== undefined) {
      const isWorker = req.user.type === 'handyman' || req.user.type === 'company';
      data.whatsappEnabled = isWorker ? !!whatsappEnabled : false;
    }

    if (specialties !== undefined && Array.isArray(specialties)) {
      data.specialties = specialties;
      data.specialty   = specialties[0] || null;
    } else if (specialty !== undefined) {
      data.specialty   = specialty || null;
    }

    if (services !== undefined) {
      data.services = Array.isArray(services)
        ? services.map(String)
        : String(services).split(',').map((s) => s.trim()).filter(Boolean);
    }

    const updated = await prisma.user.update({ where: { id: req.user.id }, data });
    res.json(safeUser(updated));
  } catch (err) {
    console.error('[USERS] update error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

router.post('/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ფოტო ვერ მოიძებნა' });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (user.avatar?.includes('cloudinary.com')) {
      try {
        const parts    = user.avatar.split('/');
        const filename = parts[parts.length - 1].split('.')[0];
        await deleteFile('fixi/avatars/' + filename, 'image');
      } catch (_) {}
    }
    const result = await uploadBuffer(req.file.buffer, {
      folder: 'fixi/avatars',
      resource_type: 'image',
      transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
    });
    const updated = await prisma.user.update({ where: { id: req.user.id }, data: { avatar: result.secure_url } });
    res.json({ avatar: updated.avatar });
  } catch (err) {
    console.error('[USERS] avatar error:', err.message);
    res.status(500).json({ error: 'ატვირთვა ვერ მოხდა' });
  }
});

router.post('/portfolio', requireAuth, upload.array('files', 10), handleCloudinaryUpload, async (req, res) => {
  try {
    const user     = await prisma.user.findUnique({ where: { id: req.user.id } });
    const existing = Array.isArray(user.portfolio) ? user.portfolio : [];
    const newFiles = req.uploadedFiles || [];
    const combined = [...existing, ...newFiles].slice(0, 20);
    const updated  = await prisma.user.update({ where: { id: req.user.id }, data: { portfolio: combined } });
    res.json({ portfolio: updated.portfolio });
  } catch (err) {
    console.error('[USERS] portfolio upload error:', err.message);
    res.status(500).json({ error: 'ატვირთვა ვერ მოხდა' });
  }
});

router.delete('/portfolio/:index', requireAuth, async (req, res) => {
  try {
    const idx  = parseInt(req.params.index);
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const port = Array.isArray(user.portfolio) ? [...user.portfolio] : [];
    if (idx < 0 || idx >= port.length) return res.status(404).json({ error: 'ინდექსი ვერ მოიძებნა' });
    const [removed] = port.splice(idx, 1);
    if (removed?.publicId) await deleteFile(removed.publicId, removed.type === 'video' ? 'video' : 'image');
    const updated = await prisma.user.update({ where: { id: req.user.id }, data: { portfolio: port } });
    res.json({ portfolio: updated.portfolio });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /:id — full user is returned, so whatsappEnabled is included automatically
router.get('/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        reviewsReceived: {
          include: { reviewer: { select: { id: true, name: true, surname: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!user) return res.status(404).json({ error: 'მომხმარებელი ვერ მოიძებნა' });
    if (user.blocked) return res.status(404).json({ error: 'ანგარიში დაბლოკილია' });
    res.json(safeUser(user));
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
