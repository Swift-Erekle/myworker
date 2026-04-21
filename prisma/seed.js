// prisma/seed.js
// Run: node prisma/seed.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ── System accounts (created ONCE, never overwritten) ────────
  const adminExists = await prisma.user.findUnique({ where: { email: 'admin@xelosani.ge' } });
  if (!adminExists) {
    await prisma.user.create({
      data: {
        id: 'admin1',
        name: 'ადმინი', surname: 'სისტემა',
        email: 'admin@xelosani.ge',
        password: await bcrypt.hash('Admin123!', 12),
        type: 'admin', verified: true, emailVerified: true,
        phone: '+995 555 000 000',
      },
    });
    console.log('  ✅ Admin created');
  } else {
    console.log('  ⏭️  Admin already exists, skipping');
  }

  const staffExists = await prisma.user.findUnique({ where: { email: 'staff@xelosani.ge' } });
  if (!staffExists) {
    await prisma.user.create({
      data: {
        id: 'staff1',
        name: 'სუპორტი', surname: 'გუნდი',
        email: 'staff@xelosani.ge',
        password: await bcrypt.hash('Staff123!', 12),
        type: 'staff', verified: true, emailVerified: true,
        phone: '+995 555 000 001',
      },
    });
    console.log('  ✅ Staff created');
  } else {
    console.log('  ⏭️  Staff already exists, skipping');
  }

  // ── Demo users ───────────────────────────────────────────────
  const demoPass = await bcrypt.hash('Demo1234!', 12);

  const nino = await prisma.user.upsert({
    where: { email: 'nino@demo.ge' },
    update: {},
    create: {
      name: 'ნინო', surname: 'მაისურაძე',
      email: 'nino@demo.ge', password: demoPass,
      type: 'user', verified: true, emailVerified: true,
      phone: '+995 555 001 001',
    },
  });

  const giorgi = await prisma.user.upsert({
    where: { email: 'giorgi@demo.ge' },
    update: {},
    create: {
      name: 'გიორგი', surname: 'ბერიძე',
      email: 'giorgi@demo.ge', password: demoPass,
      type: 'handyman', verified: true, emailVerified: true,
      phone: '+995 555 123 456',
      specialty: 'ელექტრიკოსი', city: 'ვაკე',
      specialties: ['ელექტრიკოსი'],
      desc: '15 წლის გამოცდილება ელექტრო სამუშაოებში. ვაძლევ 1 წლის გარანტიას.',
      services: ['გაყვანილობა', 'განათება', 'ავარიული სამუშაო'],
      emoji: '⚡', color: '#ff6b2b22', jobs: 134,
      vipType: 'vipp',
      vipActivatedAt: new Date(),
      vipExpiresAt: new Date(Date.now() + 4 * 86400000),
    },
  });

  const levan = await prisma.user.upsert({
    where: { email: 'levan@demo.ge' },
    update: {},
    create: {
      name: 'ლევან', surname: 'კვარაცხელია',
      email: 'levan@demo.ge', password: demoPass,
      type: 'handyman', verified: true, emailVerified: true,
      phone: '+995 555 234 567',
      specialty: 'სანტექნიკი', city: 'საბურთალო',
      specialties: ['სანტექნიკი'],
      desc: 'გამოცდილი სანტექნიკი. 24/7 გამოძახება.',
      services: ['გაჟონვა', 'მილები', 'ბოილერი'],
      emoji: '🔧', color: '#3498db22', jobs: 98,
      vipType: 'vip',
      vipActivatedAt: new Date(),
      vipExpiresAt: new Date(Date.now() + 3 * 86400000),
    },
  });

  await prisma.user.upsert({
    where: { email: 'davit@demo.ge' },
    update: {},
    create: {
      name: 'დავით', surname: 'მაისურაძე',
      email: 'davit@demo.ge', password: demoPass,
      type: 'handyman', verified: false, emailVerified: true,
      phone: '+995 555 456 789',
      specialty: 'დურგალი', city: 'ისანი',
      specialties: ['დურგალი'],
      desc: 'ავეჯის დამზადება და შეკეთება.',
      services: ['ავეჯი', 'კარ-ფანჯარა', 'პარკეტი'],
      emoji: '🪚', color: '#27ae6022', jobs: 52,
    },
  });

  // ── Demo requests ────────────────────────────────────────────
  const req1 = await prisma.request.upsert({
    where: { id: 'req-demo-1' },
    update: {},
    create: {
      id: 'req-demo-1',
      userId: nino.id,
      title: 'სამზარეულოში გაჟონვა',
      category: 'სანტექნიკი',
      desc: 'ონკანის ქვეშ გაჟონვაა. გადაუდებელია.',
      city: 'ვაკე', budget: 100, urgency: 'urgent', status: 'open',
    },
  });

  await prisma.request.upsert({
    where: { id: 'req-demo-2' },
    update: {},
    create: {
      id: 'req-demo-2',
      userId: nino.id,
      title: 'კედლის მოხატვა',
      category: 'მხატვარი',
      desc: '20კვ.მ ოთახი, ღია ფერი.',
      city: 'საბურთალო', budget: 300, urgency: 'normal', status: 'open',
    },
  });

  // ── Demo reviews ─────────────────────────────────────────────
  await prisma.review.upsert({
    where: { reviewerId_handymanId: { reviewerId: nino.id, handymanId: giorgi.id } },
    update: {},
    create: {
      reviewerId: nino.id, handymanId: giorgi.id,
      stars: 5, comment: 'ძალიან კარგი მუშა, სუფთა და სწრაფი!',
    },
  });

  await prisma.review.upsert({
    where: { reviewerId_handymanId: { reviewerId: nino.id, handymanId: levan.id } },
    update: {},
    create: {
      reviewerId: nino.id, handymanId: levan.id,
      stars: 4, comment: 'კარგი სამუშაო, ოდნავ გვიან მოვიდა.',
    },
  });

  console.log('  ✅ Demo data seeded');
  console.log('\n🎉 Seed complete!\n');
  console.log('Demo accounts (password: Demo1234!):');
  console.log('  👤 User:     nino@demo.ge');
  console.log('  🔧 Handyman: giorgi@demo.ge');
  console.log('  🔧 Handyman: levan@demo.ge');
  console.log('  🛡️  Admin:   admin@xelosani.ge  (Admin123!)');
  console.log('  👤 Staff:   staff@xelosani.ge  (Staff123!)\n');
}

main()
  .catch((e) => { console.error('Seed error:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
