// utils/expoPush.js
// Expo Push Notifications server-side helper
// Install: npm install expo-server-sdk

let Expo;
try {
  ({ Expo } = require('expo-server-sdk'));
} catch (_) {
  console.warn('[EXPO PUSH] expo-server-sdk not installed. Run: npm install expo-server-sdk');
}

const expo = Expo ? new Expo() : null;

/**
 * Send a push notification to all Expo tokens of a user.
 * Auto-removes invalid/expired tokens from DB.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 * @param {{ title, body, data?, sound?, badge? }} payload
 */
async function sendExpoPushToUser(prisma, userId, payload) {
  if (!expo) return;
  try {
    const records = await prisma.expoPushToken.findMany({ where: { userId } });
    if (!records.length) return;

    const messages = records
      .filter(r => Expo.isExpoPushToken(r.token))
      .map(r => ({
        to:    r.token,
        sound: payload.sound ?? 'default',
        title: payload.title,
        body:  payload.body,
        data:  payload.data  ?? {},
        badge: payload.badge ?? 1,
        channelId: payload.channelId ?? 'default',
      }));

    if (!messages.length) return;

    // Expo recommends batching
    const chunks  = expo.chunkPushNotifications(messages);
    const tickets = [];
    for (const chunk of chunks) {
      const t = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...t);
    }

    // Check tickets and remove dead tokens
    const expiredTokens = [];
    tickets.forEach((ticket, i) => {
      if (ticket.status === 'error') {
        if (ticket.details?.error === 'DeviceNotRegistered') {
          expiredTokens.push(records[i]?.token);
        }
        console.warn('[EXPO PUSH] Ticket error:', ticket.message);
      }
    });

    if (expiredTokens.length) {
      await prisma.expoPushToken.deleteMany({
        where: { token: { in: expiredTokens.filter(Boolean) } },
      });
    }
  } catch (err) {
    console.error('[EXPO PUSH] sendExpoPushToUser error:', err.message);
  }
}

/**
 * Send push to all staff/admin users.
 */
async function sendExpoPushToStaff(prisma, payload) {
  if (!expo) return;
  try {
    const records = await prisma.expoPushToken.findMany({
      where: { user: { type: { in: ['staff', 'admin'] } } },
    });
    if (!records.length) return;

    const messages = records
      .filter(r => Expo.isExpoPushToken(r.token))
      .map(r => ({
        to: r.token,
        sound: 'default',
        title: payload.title,
        body:  payload.body,
        data:  payload.data ?? {},
        badge: 1,
        channelId: 'default',
      }));

    if (!messages.length) return;
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (err) {
    console.error('[EXPO PUSH] sendExpoPushToStaff error:', err.message);
  }
}

module.exports = { sendExpoPushToUser, sendExpoPushToStaff };
