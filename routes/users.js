// routes/users.js
const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { upload, handleCloudinaryUpload } = require('../middleware/upload');
const { deleteFile } = require('../utils/cloudinary');

const router = express.Router();

function safeUser(u) {
  const { password, ...rest } = u;
  return rest;
}

function vipActive(user) {
  if (!user.vipType || user.vipType === 'none') return false;
  return user.vipExpiresAt && user.vipExpiresAt > new Date();
}

function buildHandymanWhere(query) {
  const where = {
    type: { in: ['handyman', 'company'] },
    blocked: false,
  };
  if (query.specialty) where.specialty = query.specialty;
  if (query.city) where.city = { contains: query.city, mode: 'insensitive' };
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { surname: { contains: query.q, mode: 'insensitive' } },
      { specialty: { contains: query.q, mode: 'insensitive' } },
    ];
  }
  return where;
}

// GET /api/users/handymen — list handymen (public)
router.get('/handymen', async (req, res) => {
  try {
    const where = buildHandymanWhere(req.query);
    const handymen = await prisma.user.findMany({
      where,
      select: {
        id: true, name: true, surname: true, type: true,
        specialty: true, city: true, desc: true, services: true,
        emoji: true, color: true, verified: true, jobs: true,
        vipType: true, vipExpiresAt: true, vipActivatedAt: true,
        portfolio: true, createdAt: true,
        reviewsReceived: {
          select: { stars: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Filter by min rating if requested
    const minRating = parseFloat(req.query.minRating);
    let result = handymen;
    if (minRating > 0) {
      result = handymen.filter((h) => {
        if (!h.reviewsReceived.length) return false;
        const avg = h.reviewsReceived.reduce((s, r) => s + r.stars, 0) / h.reviewsReceived.length;
        return avg >= minRating;
      });
    }

    // Sort: vipp > vip > rating
    result.sort((a, b) => {
      const wa = vipActive(a) ? (a.vipType === 'vipp' ? 2 : 1) : 0;
      const wb = vipActive(b) ? (b.vipType === 'vipp' ? 2 : 1) : 0;
      if (wa !== wb) return wb - wa;
      if (wa === wb && wa > 0) {
        return new Date(b.vipActivatedAt) - new Date(a.vipActivatedAt);
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

// GET /api/users/:id — get profile (public)
router.get('/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        reviewsReceived: {
          include: {
            reviewer: { select: { id: true, name: true, surname: true } },
          },
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

// PATCH /api/users/me — update own profile
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const { name, surname, phone, specialty, desc, services, city, emoji } = req.body;
    const data = {};
    if (name !== undefined) data.name = String(name).trim();
    if (surname !== undefined) data.surname = String(surname).trim();
    if (phone !== undefined) data.phone = phone || null;
    if (specialty !== undefined) data.specialty = specialty || null;
    if (desc !== undefined) data.desc = desc || null;
    if (services !== undefined) {
      data.services = Array.isArray(services)
        ? services.map(String) : String(services).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (city !== undefined) data.city = city || null;
    if (emoji !== undefined) data.emoji = emoji || '🔧';

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data,
    });
    res.json(safeUser(updated));
  } catch (err) {
    console.error('[USERS] update error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/users/portfolio — upload portfolio files
router.post(
  '/portfolio',
  requireAuth,
  upload.array('files', 10),
  handleCloudinaryUpload,
  async (req, res) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      const existing = Array.isArray(user.portfolio) ? user.portfolio : [];
      const newFiles = req.uploadedFiles || [];

      // Max 20 portfolio items
      const combined = [...existing, ...newFiles].slice(0, 20);
      const updated = await prisma.user.update({
        where: { id: req.user.id },
        data: { portfolio: combined },
      });
      res.json({ portfolio: updated.portfolio });
    } catch (err) {
      console.error('[USERS] portfolio upload error:', err.message);
      res.status(500).json({ error: 'ატვირთვა ვერ მოხდა' });
    }
  }
);

// DELETE /api/users/portfolio/:index — remove one portfolio item
router.delete('/portfolio/:index', requireAuth, async (req, res) => {
  try {
    const idx = parseInt(req.params.index);
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const portfolio = Array.isArray(user.portfolio) ? [...user.portfolio] : [];
    if (idx < 0 || idx >= portfolio.length)
      return res.status(404).json({ error: 'ინდექსი ვერ მოიძებნა' });

    const [removed] = portfolio.splice(idx, 1);
    // Delete from Cloudinary
    if (removed?.publicId) {
      await deleteFile(removed.publicId, removed.type === 'video' ? 'video' : 'image');
    }
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { portfolio },
    });
    res.json({ portfolio: updated.portfolio });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
