// routes/requests.js
const express = require('express');
const prisma = require('../utils/prisma');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { upload, handleCloudinaryUpload } = require('../middleware/upload');

const router = express.Router();

// GET /api/requests — list all open requests (public)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, city, urgency, status } = req.query;
    const where = {};
    if (category) where.category = category;
    if (city) where.city = { contains: city, mode: 'insensitive' };
    if (urgency) where.urgency = urgency;
    // Allow filtering by specific status or show all "active" (open + pending)
    if (status) {
      where.status = status;
    } else {
      // Default: show requests that still accept offers
      where.status = { in: ['open', 'pending'] };
    }

    const requests = await prisma.request.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, surname: true } },
        _count: { select: { offers: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(requests);
  } catch (err) {
    console.error('[REQUESTS] list error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/requests/mine — get current user's requests
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const requests = await prisma.request.findMany({
      where: { userId: req.user.id },
      include: {
        offers: {
          include: {
            handyman: { select: { id: true, name: true, surname: true, specialty: true, emoji: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { offers: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ═══════════════════════════════════════════════════════════
// FAVORITES (Feature 2.8)
// Handyman/company bookmarks requests to revisit later.
// All routes below require auth.
// ═══════════════════════════════════════════════════════════

// GET /api/requests/favorites — list current user's favorited requests
router.get('/favorites', requireAuth, async (req, res) => {
  try {
    const favorites = await prisma.favoriteRequest.findMany({
      where: { userId: req.user.id },
      include: {
        request: {
          include: {
            user: { select: { id: true, name: true, surname: true } },
            _count: { select: { offers: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    // Return just the requests (with meta). Filter out ones where request was deleted.
    const result = favorites
      .filter(f => f.request)
      .map(f => ({ ...f.request, favoritedAt: f.createdAt }));
    res.json(result);
  } catch (err) {
    console.error('[REQUESTS] favorites list error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/requests/:id/favorite — add to favorites
router.post('/:id/favorite', requireAuth, async (req, res) => {
  try {
    // Only handymen/companies can favorite requests
    if (!['handyman', 'company'].includes(req.user.type)) {
      return res.status(403).json({ error: 'მხოლოდ ხელოსანს ან კომპანიას შეუძლია შენახვა' });
    }

    const exists = await prisma.request.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true },
    });
    if (!exists) return res.status(404).json({ error: 'მოთხოვნა ვერ მოიძებნა' });
    // Can't favorite your own request
    if (exists.userId === req.user.id) {
      return res.status(400).json({ error: 'საკუთარი მოთხოვნის შენახვა არ შეიძლება' });
    }

    // Idempotent — upsert so duplicate calls don't error
    const fav = await prisma.favoriteRequest.upsert({
      where: { userId_requestId: { userId: req.user.id, requestId: req.params.id } },
      update: {},
      create: { userId: req.user.id, requestId: req.params.id },
    });
    res.json({ favorited: true, id: fav.id });
  } catch (err) {
    console.error('[REQUESTS] favorite error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// DELETE /api/requests/:id/favorite — remove from favorites
router.delete('/:id/favorite', requireAuth, async (req, res) => {
  try {
    await prisma.favoriteRequest.deleteMany({
      where: { userId: req.user.id, requestId: req.params.id },
    });
    res.json({ favorited: false });
  } catch (err) {
    console.error('[REQUESTS] unfavorite error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// GET /api/requests/:id — single request
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const req_ = await prisma.request.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, name: true, surname: true } },
        offers: {
          include: {
            handyman: {
              select: {
                id: true, name: true, surname: true, specialty: true,
                emoji: true, color: true, verified: true,
                reviewsReceived: { select: { stars: true } },
              },
            },
          },
        },
      },
    });
    if (!req_) return res.status(404).json({ error: 'მოთხოვნა ვერ მოიძებნა' });

    // Add favorited flag for the current user (if logged in as worker)
    if (req.user && ['handyman', 'company'].includes(req.user.type)) {
      const fav = await prisma.favoriteRequest.findUnique({
        where: { userId_requestId: { userId: req.user.id, requestId: req.params.id } },
        select: { id: true },
      });
      req_.favorited = !!fav;
    } else {
      req_.favorited = false;
    }

    res.json(req_);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// POST /api/requests — create request (users only)
router.post(
  '/',
  requireAuth,
  upload.array('media', 5),
  handleCloudinaryUpload,
  async (req, res) => {
    try {
      if (req.user.type !== 'user') {
        return res.status(403).json({ error: 'მხოლოდ მომხმარებელს შეუძლია მოთხოვნის შექმნა' });
      }
      const { title, category, desc, city, budget, urgency } = req.body;
      if (!title || !category) {
        return res.status(400).json({ error: 'სათაური და კატეგორია სავალდებულოა' });
      }

      const media = req.uploadedFiles || [];
      const request = await prisma.request.create({
        data: {
          userId: req.user.id,
          title: String(title).trim(),
          category,
          desc: desc || null,
          city: city || 'თბილისი',
          budget: budget ? parseInt(budget) : null,
          urgency: urgency === 'urgent' ? 'urgent' : 'normal',
          media,
        },
        include: { _count: { select: { offers: true } } },
      });
      res.status(201).json(request);
    } catch (err) {
      console.error('[REQUESTS] create error:', err.message);
      res.status(500).json({ error: 'სერვერის შეცდომა' });
    }
  }
);

// PATCH /api/requests/:id/status — mark completed
router.patch('/:id/status', requireAuth, async (req, res) => {
  try {
    const request = await prisma.request.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'მოთხოვნა ვერ მოიძებნა' });
    if (request.userId !== req.user.id && req.user.type !== 'admin') {
      return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    }
    const { status } = req.body;
    if (!['open', 'pending', 'in_progress', 'completed', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'სტატუსი არასწორია' });
    }
    const updated = await prisma.request.update({ where: { id: req.params.id }, data: { status } });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// DELETE /api/requests/:id — delete (owner or admin)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const request = await prisma.request.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'მოთხოვნა ვერ მოიძებნა' });
    if (request.userId !== req.user.id && req.user.type !== 'admin') {
      return res.status(403).json({ error: 'წვდომა აკრძალულია' });
    }
    await prisma.request.delete({ where: { id: req.params.id } });
    res.json({ message: 'მოთხოვნა წაიშალა' });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
