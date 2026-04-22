// routes/push.js
// Web Push subscription management
const express = require('express');
const prisma  = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/push/vapid-public-key — frontend needs this to subscribe
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key || key.startsWith('YOUR_')) {
    return res.status(503).json({ error: 'Push notifications not configured' });
  }
  res.json({ publicKey: key });
});

// POST /api/push/subscribe — save a push subscription for the logged-in user
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Subscription data is incomplete' });
    }

    // Upsert: same endpoint might be re-registered (e.g. after SW update)
    await prisma.pushSubscription.upsert({
      where:  { endpoint },
      update: { p256dh: keys.p256dh, auth: keys.auth, userId: req.user.id },
      create: { userId: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[PUSH] subscribe error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// DELETE /api/push/unsubscribe — remove subscription(s) on logout
router.delete('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) {
      // Remove specific subscription
      await prisma.pushSubscription.deleteMany({
        where: { endpoint, userId: req.user.id },
      });
    } else {
      // Remove ALL subscriptions for this user (full logout)
      await prisma.pushSubscription.deleteMany({
        where: { userId: req.user.id },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;

// ══════════════════════════════════════════════════════════════
// 📱 EXPO PUSH TOKEN (Mobile App)
// ══════════════════════════════════════════════════════════════

// POST /api/push/expo-token — save Expo push token from mobile app
router.post('/expo-token', requireAuth, async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token || !token.startsWith('ExponentPushToken')) {
      return res.status(400).json({ error: 'Invalid Expo push token' });
    }
    await prisma.expoPushToken.upsert({
      where:  { token },
      update: { userId: req.user.id, platform: platform || null },
      create: { userId: req.user.id, token, platform: platform || null },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUSH] expo-token save error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

// DELETE /api/push/expo-token — remove on logout
router.delete('/expo-token', requireAuth, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (token) {
      await prisma.expoPushToken.deleteMany({
        where: { token, userId: req.user.id },
      });
    } else {
      await prisma.expoPushToken.deleteMany({
        where: { userId: req.user.id },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});
