// routes/notifications.js
// ══════════════════════════════════════════════════════════════
// In-app bell notifications — separate from web/expo push.
// These are stored in DB and shown as a dropdown list inside the app.
// ══════════════════════════════════════════════════════════════
const express = require('express');
const prisma  = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/notifications ────────────────────────────────────
// Return most recent 30 notifications + unread count
router.get('/', requireAuth, async (req, res) => {
  try {
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where:   { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take:    30,
      }),
      prisma.notification.count({
        where: { userId: req.user.id, read: false },
      }),
    ]);
    res.json({ notifications, unreadCount });
  } catch (err) {
    console.error('[NOTIF] list error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── POST /api/notifications/read — mark one or all as read ────
router.post('/read', requireAuth, async (req, res) => {
  try {
    const { id } = req.body;                       // optional; if null → mark all
    const where = { userId: req.user.id, read: false };
    if (id) where.id = id;
    await prisma.notification.updateMany({ where, data: { read: true } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[NOTIF] read error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ── DELETE /api/notifications/:id ─────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await prisma.notification.deleteMany({
      where: { id: req.params.id, userId: req.user.id },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// ══════════════════════════════════════════════════════════════
// Helper — call from anywhere in the backend to emit a new notification.
// Creates DB row AND emits a socket event to the user's room.
// ══════════════════════════════════════════════════════════════
async function createNotification({ prisma, io, userId, type, title, body, link }) {
  try {
    const notif = await prisma.notification.create({
      data: { userId, type, title, body: body || null, link: link || null },
    });
    // Emit to the user's personal room so any open UI updates immediately
    if (io) io.to(`user:${userId}`).emit('notification', notif);
    return notif;
  } catch (err) {
    console.error('[NOTIF] createNotification error:', err.message);
    return null;
  }
}

module.exports = router;
module.exports.createNotification = createNotification;
