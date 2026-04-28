// server.js
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const helmet     = require('helmet');
const path       = require('path');
const rateLimit  = require('express-rate-limit');
const { Server } = require('socket.io');

const { setupSocket } = require('./socket');
const prisma         = require('./utils/prisma');
const { seoMiddleware, closeSeoBrowser } = require('./utils/seoRender');

const authRoutes    = require('./routes/auth');
const userRoutes    = require('./routes/users');
const requestRoutes = require('./routes/requests');
const offerRoutes   = require('./routes/offers');
const chatRoutes    = require('./routes/chat');
const adminRoutes   = require('./routes/admin');
const paymentRoutes = require('./routes/payment');
const ariaRoutes    = require('./routes/aria');
const pushRoutes    = require('./routes/push');
const notificationRoutes = require('./routes/notifications');
const proposalRoutes     = require('./routes/proposals');

// ── Startup validation: critical secrets ──────────────────────
const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ FATAL: missing required env var: ${key}`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.warn('⚠️ JWT_SECRET should be at least 32 characters for security');
}

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ── CORS configuration ────────────────────────────────────────
// Production allows both Railway URL and fixi.ge (when domain is added).
// Override with CORS_ORIGIN env var if you need something different.
const corsOrigin = process.env.CORS_ORIGIN
  || (process.env.NODE_ENV === 'production'
      ? ['https://myworker-production.up.railway.app', 'https://fixi.ge', 'https://www.fixi.ge']
      : '*');

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:  corsOrigin,
    methods: ['GET', 'POST'],
  },
});
setupSocket(io);
app.set('io', io);

// ── Middleware ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin:       corsOrigin,
  methods:      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate limiting ──────────────────────────────────────────────
// Global limiter — generous default for logged-in usage.
// Individual routes can stack additional, stricter limits.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,           // 1 minute
  max:      120,                 // 120 requests / minute per IP
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'ძალიან ბევრი მოთხოვნა — ცოტა ხანში სცადე ხელახლა' },
  // Skip rate limits in development
  skip: () => process.env.NODE_ENV !== 'production',
});

// Stricter limiter for write-heavy endpoints
const writeHeavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'ძალიან ბევრი მოთხოვნა — ცოტა ხანში სცადე ხელახლა' },
  skip: () => process.env.NODE_ENV !== 'production',
});

// Apply global limit to /api. Auth routes already have their own limiter inside.
app.use('/api', apiLimiter);

// ── API Routes ─────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/users',    userRoutes);
app.use('/api/requests', writeHeavyLimiter, requestRoutes);
app.use('/api/offers',   writeHeavyLimiter, offerRoutes);
app.use('/api/chat',     chatRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/payment',  paymentRoutes);
app.use('/api/aria',     ariaRoutes);
app.use('/api/push',     pushRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/proposals', writeHeavyLimiter, proposalRoutes);

// ── Health ─────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// ── Payment result pages ───────────────────────────────────────
app.get('/payment-success', (req, res) => {
  const { orderId, type, demo } = req.query;
  const safeOrderId = String(orderId || '').replace(/[^a-zA-Z0-9\-]/g, '');
  const safeType    = String(type || 'vip').replace(/[^a-zA-Z0-9]/g, '');
  res.send(`<!DOCTYPE html><html lang="ka">
<head><meta charset="UTF-8"><title>გადახდა</title>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: 'PAYMENT_SUCCESS', orderId: '${safeOrderId}', payType: '${safeType}' }, '*');
    window.close();
  } else {
    setTimeout(() => { window.location.href = '/'; }, 3000);
  }
</script></head>
<body style="font-family:sans-serif;background:#0f0f13;color:#fff;text-align:center;padding:80px 20px">
<div style="font-size:64px;margin-bottom:16px">✅</div>
<h1 style="color:#2ecc71">გადახდა წარმატებულია!</h1>
<p style="color:#9998b0;margin-top:8px">${demo ? 'DEMO — ' : ''}სტატუსი გააქტიურდა.</p>
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
<p style="color:#9998b0;margin-top:8px">ცადეთ ხელახლა ან დაგვიკავშირდით: support@fixi.ge</p>
<p style="color:#9998b0;font-size:13px;margin-top:16px">3 წამში გადამისამართება...</p>
</body></html>`);
});

// ── SEO: Sitemap.xml (dynamic) ─────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  try {
    const SITE = process.env.SITE_URL || 'https://myworker-production.up.railway.app';
    const [handymen, requests] = await Promise.all([
      prisma.user.findMany({
        where:  { type: { in: ['handyman','company'] }, blocked: false },
        select: { id: true, updatedAt: true },
      }),
      prisma.request.findMany({
        where:  { status: { in: ['open','pending'] } },
        select: { id: true, updatedAt: true },
      }),
    ]);
    const staticUrls = [
      { loc: SITE + '/',              changefreq: 'daily',   priority: '1.0' },
      { loc: SITE + '/?nav=handymen', changefreq: 'daily',   priority: '0.9' },
      { loc: SITE + '/?nav=requests', changefreq: 'hourly',  priority: '0.9' },
      { loc: SITE + '/terms.html',    changefreq: 'monthly', priority: '0.3' },
      { loc: SITE + '/privacy.html',  changefreq: 'monthly', priority: '0.3' },
    ];
    const handymenUrls = handymen.map(h => ({
      loc: `${SITE}/?user=${h.id}`,
      lastmod: new Date(h.updatedAt).toISOString().split('T')[0],
      changefreq: 'weekly', priority: '0.8',
    }));
    const requestUrls = requests.map(r => ({
      loc: `${SITE}/?req=${r.id}`,
      lastmod: new Date(r.updatedAt).toISOString().split('T')[0],
      changefreq: 'daily', priority: '0.7',
    }));
    const all = [...staticUrls, ...handymenUrls, ...requestUrls];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${all.map(u => `  <url>
    <loc>${u.loc}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    console.error('[SITEMAP]', err.message);
    res.status(500).send('<?xml version="1.0"?><urlset/>');
  }
});

// ── SEO: Dynamic Rendering for bot User-Agents ─────────────────
// Detects Googlebot / Facebook / Telegram / Twitter etc. and serves
// pre-rendered HTML via Puppeteer (cached). For humans → SPA as usual.
app.use(seoMiddleware);

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

// ══════════════════════════════════════════════════════════════
// ⏰ CRON JOBS
// ══════════════════════════════════════════════════════════════
(function startCronJobs() {
  let cron;
  try { cron = require('node-cron'); } catch (_) {
    console.warn('[CRON] node-cron not installed. Run: npm install node-cron');
    return;
  }

  const { sendEmail, renewalFailedTemplate } = require('./utils/email');
  const { runAutoRenewals } = require('./routes/payment');

  // ── 1. Plan expiry checks — daily at 06:00 ─────────────────
  cron.schedule('0 6 * * *', async () => {
    console.log('[CRON] Running plan expiry checks...');
    const now = new Date();
    try {
      // Expire Start trial users
      const trialExpired = await prisma.user.updateMany({
        where: {
          plan: 'start',
          trialExpiresAt: { lt: now },
          subscriptionStatus: { not: 'expired' },
        },
        data: { subscriptionStatus: 'expired' },
      });
      if (trialExpired.count > 0) console.log(`[CRON] ${trialExpired.count} start trial(s) expired`);

      // Expire Pro/Top plan users (only if autoRenew=false or no saved card)
      const planExpired = await prisma.user.updateMany({
        where: {
          plan: { in: ['pro', 'top'] },
          planExpiresAt: { lt: now },
          autoRenew: false,
          subscriptionStatus: { not: 'expired' },
        },
        data: {
          subscriptionStatus: 'expired',
          plan: 'start',
          vipType: 'none',
          vipExpiresAt: null,
        },
      });
      if (planExpired.count > 0) console.log(`[CRON] ${planExpired.count} plan(s) expired (autoRenew=false)`);

      // Also expire plans where card charge likely failed (expired > 2 days ago)
      const twoDaysAgo = new Date(now.getTime() - 2 * 86400000);
      const hardExpired = await prisma.user.updateMany({
        where: {
          plan: { in: ['pro', 'top'] },
          planExpiresAt: { lt: twoDaysAgo },
          subscriptionStatus: { not: 'expired' },
        },
        data: {
          subscriptionStatus: 'expired',
          plan: 'start',
          vipType: 'none',
          vipExpiresAt: null,
        },
      });
      if (hardExpired.count > 0) console.log(`[CRON] ${hardExpired.count} overdue plan(s) force-expired`);

      // Remove expired VIP badges
      const vipExpired = await prisma.user.updateMany({
        where: {
          vipType: { not: 'none' },
          vipExpiresAt: { lt: now },
          plan: { not: 'top' }, // TOP plan VIP+ is managed by cron below
        },
        data: { vipType: 'none' },
      });
      if (vipExpired.count > 0) console.log(`[CRON] ${vipExpired.count} VIP badge(s) removed`);

      // Clean up expired verify codes
      await prisma.verifyCode.deleteMany({ where: { expiresAt: { lt: now } } });
    } catch (err) {
      console.error('[CRON] Expiry check error:', err.message);
    }
  });

  // ── 2. ✅ NEW: Subscription auto-renewal — daily at 08:00 ───
  // Charges saved cards for users whose plan expires in next 24h
  cron.schedule('0 8 * * *', async () => {
    console.log('[CRON] Running subscription auto-renewals...');
    try {
      const results = await runAutoRenewals();
      console.log(`[CRON] Auto-renewal complete: ${results.renewed.length} renewed, ${results.failed.length} failed`);

      // Notify users whose renewal failed
      for (const fail of results.failed) {
        try {
          const user = await prisma.user.findUnique({ where: { id: fail.userId } });
          if (user?.email && user.plan !== 'start') {
            await sendEmail(
              user.email,
              'Fixi.ge — ავტო-განახლება ვერ მოხდა',
              renewalFailedTemplate(user.name, user.plan, user.planExpiresAt)
            );
          }
        } catch (_) {}
      }
    } catch (err) {
      console.error('[CRON] Auto-renewal error:', err.message);
    }
  });

  // ── 3. ✅ NEW: TOP plan daily VIP+ refresh — daily at 00:05 ─
  // TOP plan users always appear first in the list.
  // We refresh vipActivatedAt daily so their "activated recently" sort wins.
  cron.schedule('5 0 * * *', async () => {
    const now = new Date();
    try {
      const topUsers = await prisma.user.updateMany({
        where: {
          plan: 'top',
          planExpiresAt: { gt: now },
        },
        data: {
          vipActivatedAt: now,   // Reset daily → always sorts to top
          vipType: 'vipp',       // Ensure VIP+ badge stays on
        },
      });
      if (topUsers.count > 0) console.log(`[CRON] ${topUsers.count} TOP plan VIP+ refreshed`);
    } catch (err) {
      console.error('[CRON] TOP refresh error:', err.message);
    }
  });

  // ── 4. Support message cleanup / weekly stats (optional) ────
  // Runs every Sunday at 07:00 — logs basic platform stats
  cron.schedule('0 7 * * 0', async () => {
    try {
      const [users, handymen, openReqs, vipActive] = await Promise.all([
        prisma.user.count({ where: { type: 'user' } }),
        prisma.user.count({ where: { type: { in: ['handyman', 'company'] } } }),
        prisma.request.count({ where: { status: 'open' } }),
        prisma.user.count({ where: { vipType: { not: 'none' }, vipExpiresAt: { gt: new Date() } } }),
      ]);
      console.log(`[CRON] Weekly stats — Users: ${users}, Handymen: ${handymen}, Open requests: ${openReqs}, VIP active: ${vipActive}`);
    } catch (_) {}
  });

  // ── 5. Request lifecycle — daily at 03:00 ───────────────────
  // Auto-close stale requests that nobody acted on
  cron.schedule('0 3 * * *', async () => {
    console.log('[CRON] Running request lifecycle cleanup...');
    const now = new Date();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);
    const thirtyDaysAgo   = new Date(now.getTime() - 30 * 86400000);

    try {
      // 5a. Close 'open' requests with zero offers older than 14 days
      const staleOpen = await prisma.request.updateMany({
        where: {
          status: 'open',
          createdAt: { lt: fourteenDaysAgo },
        },
        data: { status: 'closed' },
      });
      if (staleOpen.count > 0) console.log(`[CRON] ${staleOpen.count} open request(s) auto-closed (no offers, 14+ days)`);

      // 5b. Close 'pending' requests older than 14 days (owner didn't accept anyone)
      const stalePending = await prisma.request.updateMany({
        where: {
          status: 'pending',
          createdAt: { lt: fourteenDaysAgo },
        },
        data: { status: 'closed' },
      });
      if (stalePending.count > 0) console.log(`[CRON] ${stalePending.count} pending request(s) auto-closed (14+ days)`);

      // 5c. Archive 'completed' requests older than 30 days
      // We use a separate 'archived' flag-like status; keeps history intact.
      const archivedCount = await prisma.request.updateMany({
        where: {
          status: 'completed',
          updatedAt: { lt: thirtyDaysAgo },
        },
        data: { status: 'archived' },
      });
      if (archivedCount.count > 0) console.log(`[CRON] ${archivedCount.count} completed request(s) archived (30+ days)`);
    } catch (err) {
      console.error('[CRON] Request lifecycle error:', err.message);
    }
  });

  // ── 6. Chat cleanup — daily at 04:00 ────────────────────────
  // Delete chats with no activity for 14+ days to save DB space.
  // Cascade will delete associated messages too.
  cron.schedule('0 4 * * *', async () => {
    console.log('[CRON] Running chat cleanup (14+ days inactive)...');
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000);
    try {
      const deleted = await prisma.chat.deleteMany({
        where: { updatedAt: { lt: fourteenDaysAgo } },
      });
      if (deleted.count > 0) console.log(`[CRON] ${deleted.count} inactive chat(s) deleted`);
    } catch (err) {
      console.error('[CRON] Chat cleanup error:', err.message);
    }
  });

  // ── 7. Offer completion + review reminders — every 10 minutes ──
  // When an 'agreed' offer passes its completedAt deadline, mark it 'completed'
  // and send a review reminder to the request owner.
  const { createNotification } = require('./routes/notifications');
  const { sendPushToUser }     = require('./utils/webPush');
  const { sendExpoPushToUser } = require('./utils/expoPush');

  cron.schedule('*/10 * * * *', async () => {
    try {
      const now = new Date();
      const due = await prisma.offer.findMany({
        where: {
          status:      'agreed',
          completedAt: { lte: now, not: null },
          reviewReminderSent: false,
        },
        include: {
          request:  { select: { id: true, title: true, userId: true } },
          handyman: { select: { id: true, name: true, surname: true } },
        },
        take: 50,
      });

      for (const offer of due) {
        // Mark as completed + reviewReminderSent
        await prisma.offer.update({
          where: { id: offer.id },
          data:  { status: 'completed', reviewReminderSent: true },
        }).catch(() => {});

        // Close request if no other active offers
        const otherActive = await prisma.offer.count({
          where: {
            requestId: offer.requestId,
            id:        { not: offer.id },
            status:    { in: ['accepted', 'agreed'] },
          },
        });
        if (otherActive === 0) {
          await prisma.request.update({
            where: { id: offer.requestId },
            data:  { status: 'completed' },
          }).catch(() => {});
        }

        const ownerId = offer.request.userId;
        const handymanName = `${offer.handyman.name || ''} ${offer.handyman.surname || ''}`.trim();
        const title = '⭐ შეაფასე სამუშაო';
        const body  = `${handymanName} — "${offer.request.title}"`;

        sendPushToUser(prisma, ownerId, {
          title, body,
          tag: 'review-' + offer.id,
          url: `/?review=${offer.handymanId}`,
        }).catch(() => {});
        sendExpoPushToUser(prisma, ownerId, {
          title, body,
          data: { type: 'review_reminder', handymanId: offer.handymanId, offerId: offer.id },
        }).catch(() => {});
        createNotification({
          prisma,
          io: app.get('io'),
          userId: ownerId,
          type:   'review_reminder',
          title, body,
          link:   `?review=${offer.handymanId}`,
        }).catch(() => {});
      }
      if (due.length > 0) console.log(`[CRON] ${due.length} offer(s) marked completed — review reminders sent`);
    } catch (err) {
      console.error('[CRON] Offer completion error:', err.message);
    }
  });

  console.log('[CRON] All schedulers started:');
  console.log('  06:00 daily — plan expiry checks');
  console.log('  08:00 daily — subscription auto-renewal');
  console.log('  00:05 daily — TOP plan VIP+ refresh');
  console.log('  03:00 daily — request lifecycle cleanup');
  console.log('  04:00 daily — chat cleanup (14+ days inactive)');
  console.log('  every 10 min — offer completion / review reminders');
  console.log('  07:00 Sunday — weekly stats');
})();

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Fixi.ge backend on port ${PORT}`);
  console.log(`   Env: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});

process.on('SIGTERM', async () => { await closeSeoBrowser(); await prisma.$disconnect(); server.close(() => process.exit(0)); });
process.on('SIGINT',  async () => { await closeSeoBrowser(); await prisma.$disconnect(); process.exit(0); });
