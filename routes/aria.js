// routes/aria.js
// Gemini API proxy — keeps API key on server, never exposed to frontend
const express = require('express');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const ariaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'ძალიან ბევრი მოთხოვნა. 1 წუთში ისევ სცადე.' },
});

// ── System Prompt ─────────────────────────────────────────────
const ARIA_SYSTEM = `შენ ხარ ARIA — Fixi.ge-ის AI ასისტენტი. Fixi.ge — საქართველოს #1 ხელოსნების პლატფორმა.

საიტი: პლატფორმა, სადაც მომხმარებლები აქვეყნებენ სამუშაო მოთხოვნებს, ხელოსნები/კომპანიები კი გაგზავნიან შეთავაზებებს.

ანგარიშის ტიპები:
- მომხმარებელი (user): ეძებს ხელოსანს, უფასოდ იყენებს პლატფორმას.
- ხელოსანი (handyman): ასრულებს სამუშაოს, საჭიროა ტარიფი.
- კომპანია (company): გუნდი/ბრიგადა, საჭიროა ტარიფი.

VIP სისტემა ხელოსნებისთვის:
- VIP: 2₾/1 დღე ან 10₾/5 დღე — სიის სათავეში ძიების შედეგებში.
- VIP+: 4₾/1 დღე ან 18₾/5 დღე — ყოველთვის VIP-ზე მაღლა.

VIP სისტემა კომპანიებისთვის:
- VIP: 5₾/1 დღე ან 25₾/5 დღე.
- VIP+: 10₾/1 დღე ან 50₾/5 დღე — სპეციალურ "🏢 კომპანიების" სექციაში.

ტარიფები ხელოსნებისთვის:
- Start: 0₾ — 3 თვე უფასო, 5 შეთ./თვე.
- Pro: 29₾/თვე — ულიმიტო შეთავაზებები, მაღალი პოზიცია, ავტო-განახლება.
- TOP: 69₾/თვე — Pro + ყოველდღე ავტო VIP+ + TOP ბეჯი.

ტარიფები კომპანიებისთვის:
- Start: 0₾ — 3 თვე უფასო, 5 შეთ./თვე.
- Pro: 99₾/თვე — ულიმიტო შეთავაზებები.
- TOP: 159₾/თვე — Pro + ავტო VIP+ + 🏢 კომპანიების სექცია.

TOP ტარიფი ავტომატურად ააქტიურებს VIP+ სტატუსს მთელი ვადით.
ყველა ტარიფი ავტომატურად განახლდება 30 დღეში (გამორთვა: პარამეტრები → ბარათი).

გადახდა: TBC Pay-ით. პლატფორმა ბარათის სრულ მონაცემებს არ ინახავს.

Voice: მეგობრული, ქართულად, ლაკონური.
თუ user-ის ტიპი უცნობია — ჰკითხე: "ხელოსანი ხარ, კომპანია, თუ მომხმარებელი?"
Operator trigger: "ვაკავშირებ ოპერატორთან!" + [OPERATOR_REQUEST].

კონტაქტი: support@fixi.ge.`;

// ── Static greeting patterns (no API call needed) ─────────────
const GREETINGS = [
  /^გამარჯობა[!?.]*$/i,
  /^გამარჯობა\s*aria[!?.]*$/i,
  /^სალამი?[!?.]*$/i,
  /^hi+[!?.]*$/i,
  /^hello[!?.]*$/i,
  /^hey[!?.]*$/i,
  /^მოგესალმები[!?.]*$/i,
  /^ჰეი[!?.]*$/i,
];

const GREETING_REPLIES = [
  'გამარჯობა! 👋 მე ვარ ARIA — Fixi.ge-ის ასისტენტი. როგორ დაგეხმარო?',
  'გამარჯობა! 😊 ARIA ვარ, Fixi.ge-ის ხელოსნების პლატფორმის დამხმარე. მკითხე ნებისმიერი რამ!',
  'სალამი! 👋 Fixi.ge-ის ARIA ვარ. რით შემიძლია დახმარება?',
];

// ── Static quick-reply answers (no token used) ────────────────
const STATIC_ANSWERS = {
  'fixi.ge როგორ მუშაობს?': `**Fixi.ge** მარტივად მუშაობს:

👤 **მომხმარებელი:**
1. დარეგისტრირდი უფასოდ
2. გამოაქვეყნე მოთხოვნა (სახელი, კატეგორია, ბიუჯეტი)
3. მიიღე შეთავაზებები ხელოსნებისგან
4. მოიწონე, გახსენი ჩათი და შეთანხმდი!

🔧 **ხელოსანი/კომპანია:**
1. შექმენი პროფილი სპეციალობით
2. ნახე მოთხოვნები და გაგზავნე შეთავაზება
3. მომხმარებელი მიიღებს და ჩათი გაიხსნება

პლატფორმა **100% უფასოა** მომხმარებლებისთვის! ✅`,

  'ტარიფები რა ღირს?': `**ხელოსნების ტარიფები:**
⭐ Start — 0₾ (3 თვე, 5 შეთ./თვე)
⚡ Pro — 29₾/თვე (ულიმიტო)
🔝 TOP — 69₾/თვე (Pro + ავტო VIP+)

**კომპანიების ტარიფები:**
⭐ Start — 0₾ (3 თვე)
⚡ Pro — 99₾/თვე
🔝 TOP — 159₾/თვე

ყველა ტარიფი ავტომატურად განახლდება. გამორთვა შეგიძლია ნებისმიერ დროს.
გადახდა TBC Pay-ით 🔒`,

  'როგორ დავდო მოთხოვნა?': `**მოთხოვნის გამოქვეყნება 3 ნაბიჯით:**

1️⃣ **"📋 მოთხოვნები"** გვერდზე გადადი
2️⃣ დააჭირე **"+ ახალი მოთხოვნა"**
3️⃣ შეავსე:
   • სათაური (მაგ: "სამზარეულოში გაჟონვა")
   • კატეგორია
   • ქალაქი
   • ბიუჯეტი (არასავალდებულო)
   • ფოტო (სასურველია)

გამოქვეყნების შემდეგ ხელოსნები **დაუყოვნებლივ** გამოგიგზავნიან შეთავაზებებს! 🚀`,

  'vip სისტემა': `**VIP სისტემა ხელოსნებისთვის:**

⭐ **VIP** — სიის სათავეში
• 1 დღე: 2₾
• 5 დღე: 10₾

💜 **VIP+** — ყოველთვის VIP-ზე მაღლა
• 1 დღე: 4₾
• 5 დღე: 18₾

**კომპანიებისთვის:**
⭐ VIP: 5₾/1 დ. | 25₾/5 დ.
💜 VIP+: 10₾/1 დ. | 50₾/5 დ.

🔝 **TOP ტარიფი** ყოველდღე ავტომატურად ააქტიურებს VIP+-ს!

გადახდა: პროფილი → ⭐ VIP შეძენა`,

  'სუპორტთან დაკავშირება': `🎧 **სუპორტთან დაკავშირება:**

**აპლიკაცია/საიტი:**
პროფილი → 🎧 სუპორტი → დაწერე შეტყობინება

**ელ-ფოსტა:** support@fixi.ge

ჩვენი გუნდი **სამუშაო საათებში** ყოველთვის მზადაა! 
სასწრაფოდ გინდა? — **[OPERATOR_REQUEST]** ვაკავშირებ ოპერატორთან! 🎧`,
};

// ── Normalize text for static lookup ─────────────────────────
function normalize(text) {
  return text.toLowerCase().trim()
    .replace(/fixi\.ge\s*/g, 'fixi.ge ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findStaticAnswer(text) {
  const t = normalize(text);
  // Exact match
  if (STATIC_ANSWERS[t]) return STATIC_ANSWERS[t];
  // Partial match on key phrases
  if (t.includes('როგორ მუშაობ') || t.includes('fixi.ge როგო')) return STATIC_ANSWERS['fixi.ge როგორ მუშაობს?'];
  if (t.includes('ტარიფ')) return STATIC_ANSWERS['ტარიფები რა ღირს?'];
  if (t.includes('მოთხოვნა') && (t.includes('დავდო') || t.includes('გამოვაქვეყნო') || t.includes('შევქმნა'))) return STATIC_ANSWERS['როგორ დავდო მოთხოვნა?'];
  if (t.includes('vip')) return STATIC_ANSWERS['vip სისტემა'];
  if (t.includes('სუპორტ') || t.includes('ოპერატორ') || t.includes('დაკავშირება')) return STATIC_ANSWERS['სუპორტთან დაკავშირება'];
  return null;
}

function isGreeting(messages) {
  if (!messages || messages.length !== 1) return false;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return false;
  const text = (last.parts?.[0]?.text || last.text || '').trim();
  return GREETINGS.some(pattern => pattern.test(text));
}

// POST /api/aria/chat
router.post('/chat', ariaLimiter, async (req, res) => {
  try {
    const { messages, userType } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages სავალდებულოა' });
    }

    // ✅ Static greeting — no API call
    if (isGreeting(messages)) {
      const reply = GREETING_REPLIES[Math.floor(Math.random() * GREETING_REPLIES.length)];
      return res.json({ reply, static: true });
    }

    // ✅ Static quick-reply — no API call
    const lastMsg = messages[messages.length - 1];
    const lastText = (lastMsg?.parts?.[0]?.text || lastMsg?.text || '').trim();
    const staticAnswer = findStaticAnswer(lastText);
    if (staticAnswer) {
      return res.json({ reply: staticAnswer, static: true });
    }

    // ── Gemini API call ────────────────────────────────────────
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.startsWith('YOUR_')) {
      return res.status(503).json({ error: 'AI სერვისი კონფიგურირებული არ არის' });
    }

    let safeMessages = messages
      .filter(m => m.role === 'user' || m.role === 'model')
      .slice(-20)
      .map(m => ({
        role: m.role,
        parts: [{ text: String(m.parts?.[0]?.text || m.text || '').substring(0, 2000) }],
      }));

    while (safeMessages.length > 0 && safeMessages[0].role === 'model') safeMessages.shift();
    if (safeMessages.length === 0) return res.status(400).json({ error: 'messages სავალდებულოა' });

    let systemText = ARIA_SYSTEM;
    if (userType === 'user')     systemText += '\n\nმიმდინარე user: მომხმარებელი (უფასო, ტარიფი არ სჭირდება).';
    else if (userType === 'handyman') systemText += '\n\nმიმდინარე user: ხელოსანი (ხელოსნის ფასები).';
    else if (userType === 'company')  systemText += '\n\nმიმდინარე user: კომპანია (კომპანიის ფასები).';

    const body = {
      system_instruction: { parts: [{ text: systemText }] },
      contents: safeMessages,
      generationConfig: { maxOutputTokens: 800, temperature: 0.7 },
    };

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[ARIA] Gemini error:', resp.status, errText);
      return res.status(502).json({ error: 'AI სერვისი მიუწვდომელია' });
    }

    const data = await resp.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ reply });
  } catch (err) {
    console.error('[ARIA] chat error:', err.message);
    res.status(500).json({ error: 'სერვერის შეცდომა' });
  }
});

module.exports = router;
