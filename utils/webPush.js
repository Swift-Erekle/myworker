// utils/webPush.js
// Web Push Notifications via VAPID + web-push library
// Generate keys once: node -e "const wp=require('web-push');const k=wp.generateVAPIDKeys();console.log(k)"
// Then set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL in .env

let webpush;
try {
  webpush = require('web-push');
} catch (_) {
  console.warn('[PUSH] web-push not installed. Run: npm install web-push');
}

const isConfigured = () =>
  webpush &&
  process.env.VAPID_PUBLIC_KEY &&
  process.env.VAPID_PRIVATE_KEY &&
  !process.env.VAPID_PUBLIC_KEY.startsWith('YOUR_');

if (isConfigured()) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL || 'support@xelosani.ge'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  console.log('[PUSH] Web Push configured ✓');
} else {
  console.warn('[PUSH] VAPID keys not set — push notifications disabled');
}

/**
 * Send push notification to a single subscription object.
 * @param {{ endpoint, keys: { p256dh, auth } }} subscription
 * @param {{ title, body, icon?, badge?, url?, tag? }} payload
 * @returns {true | 'expired' | false}
 */
async function sendPush(subscription, payload) {
  if (!isConfigured()) return false;
  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: payload.title || 'ხელოსანი.ge',
        body:  payload.body  || '',
        icon:  payload.icon  || '/icon-192.png',
        badge: payload.badge || '/badge-72.png',
        url:   payload.url   || '/',
        tag:   payload.tag   || 'default',
      })
    );
    return true;
  } catch (err) {
    // 410 Gone / 404 = subscription no longer valid
    if (err.statusCode === 410 || err.statusCode === 404) return 'expired';
    console.error('[PUSH] sendPush error:', err.statusCode, err.message);
    return false;
  }
}

/**
 * Send push to ALL subscriptions of a user. Auto-cleans expired ones.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 * @param {object} payload
 */
async function sendPushToUser(prisma, userId, payload) {
  if (!isConfigured()) return;
  try {
    const subs = await prisma.pushSubscription.findMany({ where: { userId } });
    if (!subs.length) return;

    const expired = [];
    await Promise.all(
      subs.map(async (sub) => {
        const result = await sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        if (result === 'expired') expired.push(sub.id);
      })
    );

    if (expired.length) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: expired } } });
    }
  } catch (err) {
    console.error('[PUSH] sendPushToUser error:', err.message);
  }
}

/**
 * Send push to all staff & admin users (support alerts).
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} payload
 */
async function sendPushToStaff(prisma, payload) {
  if (!isConfigured()) return;
  try {
    const subs = await prisma.pushSubscription.findMany({
      where: { user: { type: { in: ['staff', 'admin'] } } },
    });
    if (!subs.length) return;

    const expired = [];
    await Promise.all(
      subs.map(async (sub) => {
        const result = await sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        if (result === 'expired') expired.push(sub.id);
      })
    );

    if (expired.length) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: expired } } });
    }
  } catch (err) {
    console.error('[PUSH] sendPushToStaff error:', err.message);
  }
}

module.exports = { sendPushToUser, sendPushToStaff, isConfigured };
