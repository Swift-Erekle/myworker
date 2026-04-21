# ხელოსანი.ge — Backend

Node.js + Express + PostgreSQL + Socket.io + Prisma

---

## 📁 ფაილური სტრუქტურა

```
xelosani-backend/
├── server.js              ← მთავარი ფაილი
├── package.json
├── .env                   ← (შენ ქმნი .env.example-დან)
├── .env.example
├── .gitignore
├── prisma/
│   ├── schema.prisma      ← DB სქემა
│   └── seed.js            ← საწყისი მონაცემები
├── routes/
│   ├── auth.js            ← /api/auth/*
│   ├── users.js           ← /api/users/*
│   ├── requests.js        ← /api/requests/*
│   ├── offers.js          ← /api/offers/* + /api/reviews
│   ├── chat.js            ← /api/chat/*
│   ├── admin.js           ← /api/admin/*
│   ├── payment.js         ← /api/payment/*
│   └── aria.js            ← /api/aria/* (Gemini proxy)
├── middleware/
│   ├── auth.js            ← JWT middleware
│   └── upload.js          ← Multer + Cloudinary
├── utils/
│   ├── prisma.js          ← Singleton PrismaClient
│   ├── email.js           ← SendGrid + templates
│   ├── tbcPay.js          ← TBC Pay API
│   └── cloudinary.js      ← Cloudinary upload
└── socket/
    └── index.js           ← Socket.io real-time
```

---

## 🚀 გაშვება (ლოკალური)

### 1. Prerequisites

```bash
# Node.js 18+ და PostgreSQL 14+
node --version   # v18+
psql --version   # 14+
```

### 2. PostgreSQL ბაზის შექმნა

```bash
psql -U postgres
CREATE DATABASE xelosani;
\q
```

### 3. პროექტის setup

```bash
cd xelosani-backend
npm install

# .env ფაილის შექმნა
cp .env.example .env
# შეავსე .env შენი API გასაღებებით
```

### 4. Database migration

```bash
# Prisma სქემის DB-ზე გამოყენება
npx prisma migrate dev --name init

# ან სწრაფი push (dev-ისთვის)
npx prisma db push
```

### 5. Seed (საწყისი მონაცემები)

```bash
node prisma/seed.js
```

**Demo ანგარიშები (seed-ის შემდეგ):**

| როლი | ელ-ფოსტა | პაროლი |
|------|-----------|--------|
| 🛡️ Admin | admin@xelosani.ge | Admin123! |
| 👤 Staff | staff@xelosani.ge | Staff123! |
| 👤 User | nino@demo.ge | Demo1234! |
| 🔧 Handyman | giorgi@demo.ge | Demo1234! |

### 6. გაშვება

```bash
# Development (nodemon — auto-restart)
npm run dev

# Production
npm start
```

Server: `http://localhost:3000`  
Health: `http://localhost:3000/api/health`

---

## 🌐 API Endpoints

### Auth `/api/auth`
| Method | Path | Description |
|--------|------|-------------|
| POST | `/register` | რეგისტრაცია (კოდი იგზავნება ელ-ფოსტაზე) |
| POST | `/verify` | ელ-ფოსტის დადასტურება |
| POST | `/resend` | კოდის ხელახლა გაგზავნა |
| POST | `/login` | შესვლა → JWT token |
| GET | `/me` | მიმდინარე მომხმარებელი (token) |
| POST | `/forgot` | პაროლის აღდგენის კოდი |
| POST | `/reset` | ახალი პაროლის დაყენება |
| POST | `/change-password` | პაროლის შეცვლა |

### Users `/api/users`
| Method | Path | Description |
|--------|------|-------------|
| GET | `/handymen` | ხელოსნების სია (VIP sort) |
| GET | `/:id` | პროფილი + შეფასებები |
| PATCH | `/me` | საკუთარი პროფილის განახლება |
| POST | `/portfolio` | პორტფოლიოს ატვირთვა (Cloudinary) |
| DELETE | `/portfolio/:index` | პორტფოლიო ელემენტის წაშლა |

### Requests `/api/requests`
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | ყველა ღია მოთხოვნა |
| GET | `/mine` | ჩემი მოთხოვნები |
| GET | `/:id` | ერთი მოთხოვნა + შეთავაზებები |
| POST | `/` | ახალი მოთხოვნა (+ ფოტო/ვიდეო) |
| PATCH | `/:id/status` | სტატუსის განახლება |
| DELETE | `/:id` | მოთხოვნის წაშლა |

### Offers `/api/offers`
| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | შეთავაზების გაგზავნა |
| GET | `/mine` | ჩემი შეთავაზებები |
| POST | `/:id/accept` | შეთავაზების მიღება → ჩათი იხსნება |
| POST | `/reviews` | შეფასების დატოვება |

### Chat `/api/chat`
| Method | Path | Description |
|--------|------|-------------|
| GET | `/mine` | ჩემი ჩათები |
| GET | `/:id` | ერთი ჩათი + შეტყობინებები |
| GET | `/:id/messages` | paginated messages |
| POST | `/:id/messages` | შეტყობინების გაგზავნა (HTTP fallback) |
| POST | `/:id/upload` | ფოტო/ვიდეო/ხმოვანი ჩათში |

### Payment `/api/payment`
| Method | Path | Description |
|--------|------|-------------|
| POST | `/create-order` | TBC Pay ორდერის შექმნა |
| POST | `/callback` | TBC Pay webhook |
| GET | `/verify` | გადახდის სტატუსის შემოწმება |
| GET | `/history` | გადახდების ისტორია |
| GET | `/demo-confirm` | DEMO: გადახდის სიმულაცია |

### Admin `/api/admin` *(staff/admin only)*
| Method | Path | Description |
|--------|------|-------------|
| GET | `/analytics` | სტატისტიკა |
| GET | `/users` | ანგარიშების სია |
| GET | `/users/:id` | ანგარიშის დეტალები |
| PATCH | `/users/:id/block` | ბლოკვა/განბლოკვა |
| DELETE | `/users/:id` | წაშლა |
| POST | `/staff` | სტაფის შექმნა |
| GET | `/requests` | ყველა მოთხოვნა |
| DELETE | `/requests/:id` | მოთხოვნის წაშლა |
| GET | `/support` | სუპორტის მოთხოვნები |
| POST | `/support` | სუპორტის მოთხოვნის შექმნა |
| PATCH | `/support/:id/status` | სტატუსის შეცვლა |

### ARIA `/api/aria`
| Method | Path | Description |
|--------|------|-------------|
| POST | `/chat` | Gemini AI proxy (key stays on server) |

---

## 🔌 Socket.io Events

**Client → Server:**
| Event | Data | Description |
|-------|------|-------------|
| `joinChat` | `chatId` | ჩათ-რუმში შესვლა |
| `leaveChat` | `chatId` | ჩათ-რუმის დატოვება |
| `sendMessage` | `{chatId, content, type}` | შეტყობინება |
| `typing` | `{chatId, isTyping}` | ტაიპინგ ინდიკატორი |
| `joinSupport` | `supportId` | სუპორტ-რუმი |
| `sendSupportMsg` | `{supportId, content}` | სუპორტ შეტყობინება |

**Server → Client:**
| Event | Data | Description |
|-------|------|-------------|
| `newMessage` | Message object | ახალი შეტყობინება |
| `userTyping` | `{userId, isTyping}` | ტაიპინგი |
| `newSupportMsg` | SupportMessage | სუპორტ შეტყობინება |
| `supportAlert` | `{supportId}` | ახალი სუპორტ მოთხოვნა |

---

## ☁️ Production Deployment

### Railway (ყველაზე მარტივი)
```bash
npm install -g @railway/cli
railway login
railway init
railway add --plugin postgresql
railway deploy
# environment variables დაამატე Railway dashboard-ზე
```

### Render
1. New Web Service → connect GitHub repo
2. Build Command: `npm install && npx prisma migrate deploy`
3. Start Command: `npm start`
4. Add PostgreSQL database
5. Set all environment variables

### Supabase (PostgreSQL)
```bash
# DATABASE_URL-ს Supabase-დან:
# Project Settings → Database → Connection string → URI
```

---

## 🔒 Security Notes

- JWT secret უნდა იყოს მინიმუმ 64 სიმბოლო
- Rate limiting ჩართულია auth endpoints-ზე
- bcrypt rounds: 12 (production-ready)
- Helmet.js security headers
- CORS კონფიგურირებული
- SQL injection: Prisma ORM
- XSS: input validation + sanitization
- File upload: type + size validation

---

## 🐛 DeepSeek კოდის Bug Fixes

| # | პრობლემა | გამოსავალი |
|---|----------|-----------|
| 1 | `new PrismaClient()` ყველა ფაილში | Singleton pattern (`utils/prisma.js`) |
| 2 | `global.verifyCodes` — restart-ზე იშლება | DB table `VerifyCode` TTL-ით |
| 3 | chat messages JSON blob-ად | ცალკე `Message` model pagination-ით |
| 4 | socket auth missing | JWT middleware socket.io-სთვის |
| 5 | `/payment-success` route missing | TBC callback + verify endpoint |
| 6 | admin1 deletion possible | Protected in delete handler |
| 7 | No email templates imported | `emailVerifyTemplate` + `passwordResetTemplate` |
| 8 | sendEmail imported but missing | `utils/email.js` სრულად |
