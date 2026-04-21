require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { Server } = require('socket.io');
const { setupSocket } = require('./socket');
const prisma = require('./utils/prisma');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const requestRoutes = require('./routes/requests');
const offerRoutes = require('./routes/offers');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payment');
const ariaRoutes = require('./routes/aria');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
});
setupSocket(io);
app.set('io', io);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/aria', ariaRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// 🔥 მთავარი: frontend-ის მიწოდება
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/payment-success', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="background:#0f0f13;color:#fff;text-align:center;padding:60px"><h1>✅ გადახდა წარმატებულია!</h1><p>VIP სტატუსი გააქტიურდა.</p><script>setTimeout(()=>location.href='/',4000)</script></body></html>`);
});
app.get('/payment-cancel', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="background:#0f0f13;color:#fff;text-align:center;padding:60px"><h1>❌ გადახდა გაუქმდა</h1><p>ცადეთ ხელახლა.</p><script>setTimeout(()=>location.href='/',4000)</script></body></html>`);
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: 'სერვერის შეცდომა' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));