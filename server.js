// server.js
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const helmet     = require('helmet');
const path       = require('path');
const { Server } = require('socket.io');

const { setupSocket } = require('./socket');
const prisma         = require('./utils/prisma');

const authRoutes    = require('./routes/auth');      // ✅ fixed: now real auth routes
const userRoutes    = require('./routes/users');
const requestRoutes = require('./routes/requests');
const offerRoutes   = require('./routes/offers');
const chatRoutes    = require('./routes/chat');
const adminRoutes   = require('./routes/admin');
const paymentRoutes = require('./routes/payment');
const ariaRoutes    = require('./routes/aria');

const app    = express();
app.set('trust proxy', 1);   // needed behind nginx / Railway / Render
const server = http.createServer(app);

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:  process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
  },
});
setupSocket(io);
app.set('io', io);

// ── Middleware ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin:       process.env.CORS_ORIGIN || '*',
  methods:      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── API Routes ─────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/offers',   offerRoutes);
app.use('/api/chat',     chatRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/payment',  paymentRoutes);
app.use('/api/aria',     ariaRoutes);

// ── Health ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// ── Payment result pages ───────────────────────────────────────
app.get('/payment-success', (req, res) => {
  const { orderId, type, demo } = req.query;
  res.send(`<!DOCTYPE html><html lang="ka">
<head><meta charset="UTF-8"><title>გადახდა</title>
<script>
  // Notify parent window if opened in popup
  if (window.opener) {
    window.opener.postMessage({ type: 'PAYMENT_SUCCESS', orderId: '${orderId}', payType: '${type}' }, '*');
    window.close();
  } else {
    setTimeout(() => { window.location.href = '/'; }, 3000);
  }
</script></head>
<body style="font-family:sans-serif;background:#0f0f13;color:#fff;text-align:center;padding:80px 20px">
<div style="font-size:64px;margin-bottom:16px">✅</div>
<h1 style="color:#2ecc71">გადახდა წარმატებულია!</h1>
<p style="color:#9998b0;margin-top:8px">${demo ? 'DEMO — ' : ''}VIP სტატუსი გააქტიურდა.</p>
<p style="color:#9998b0;font-size:13px;margin-top:16px">3 წამში გადამისამართება...</p>
</body></html>`);
});

app.get('/payment-cancel', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="ka">
<head><meta charset="UTF-8"><title>გადახდა</title>
<script>setTimeout(() => { window.location.href = '/'; }, 3000);</script></head>
<body style="font-family:sans-serif;background:#0f0f13;color:#fff;text-align:center;padding:80px 20px">
<div style="font-size:64px;margin-bottom:16px">❌</div>
<h1 style="color:#e74c3c">გადახდა გაუქმდა</h1>
<p style="color:#9998b0;margin-top:8px">ცადეთ ხელახლა ან დაგვიკავშირდით: support@xelosani.ge</p>
<p style="color:#9998b0;font-size:13px;margin-top:16px">3 წამში გადამისამართება...</p>
</body></html>`);
});

// ── Serve frontend ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handlers ─────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'ფაილი ძალიან დიდია (მაქს. 20MB)' });
  console.error('[SERVER]', err.message);
  res.status(500).json({ error: 'სერვერის შეცდომა' });
});

// ── Cron job — plan expiry checks (runs daily at 06:00) ────────
// Requires: npm install node-cron
// Comment out if you don't have node-cron installed yet:
(function startCronJobs() {
  let cron;
  try { cron = require('node-cron'); } catch (_) {
    console.warn('[CRON] node-cron not installed. Run: npm install node-cron');
    return;
  }

  // Run at 06:00 every day
  cron.schedule('0 6 * * *', async () => {
    console.log('[CRON] Running plan expiry checks...');
    const now = new Date();

    try {
      // 1. Expire Start trial users
      const trialExpired = await prisma.user.updateMany({
        where: {
          plan:            'start',
          trialExpiresAt:  { lt: now },
          subscriptionStatus: { not: 'expired' },
        },
        data: { subscriptionStatus: 'expired' },
      });
      if (trialExpired.count > 0) console.log(`[CRON] ${trialExpired.count} start trial(s) expired`);

      // 2. Expire Pro/Top plan users
      const planExpired = await prisma.user.updateMany({
        where: {
          plan:           { in: ['pro', 'top'] },
          planExpiresAt:  { lt: now },
          subscriptionStatus: { not: 'expired' },
        },
        data: {
          subscriptionStatus: 'expired',
          plan:               'start',      // revert to start
          vipType:            'none',        // remove auto VIP+ for TOP
          vipExpiresAt:       null,
        },
      });
      if (planExpired.count > 0) console.log(`[CRON] ${planExpired.count} pro/top plan(s) expired`);

      // 3. Remove expired VIP/VIP+ badges
      const vipExpired = await prisma.user.updateMany({
        where: {
          vipType:      { not: 'none' },
          vipExpiresAt: { lt: now },
        },
        data: { vipType: 'none' },
      });
      if (vipExpired.count > 0) console.log(`[CRON] ${vipExpired.count} VIP badge(s) removed`);

      // 4. Clean up expired verify codes
      await prisma.verifyCode.deleteMany({ where: { expiresAt: { lt: now } } });
    } catch (err) {
      console.error('[CRON] Error:', err.message);
    }
  });

  console.log('[CRON] Plan expiry scheduler started (runs daily at 06:00)');
})();

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 ხელოსანი.ge backend on port ${PORT}`);
  console.log(`   Env: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});

process.on('SIGTERM', async () => { await prisma.$disconnect(); server.close(() => process.exit(0)); });
process.on('SIGINT',  async () => { await prisma.$disconnect(); process.exit(0); });
