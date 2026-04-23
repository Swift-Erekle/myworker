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

const ARIA_SYSTEM = `შენ ხარ ARIA — ხელოსანი.ge-ის AI ასისტენტი. ეს საქართველოს #1 ხელოსნების პლატფორმაა.

საიტი: პლატფორმა სადაც მომხმარებლები აქვეყნებენ სამუშაო მოთხოვნებს, ხელოსნები/კომპანიები კი გაგზავნიან შეთავაზებებს.

ანგარიშის ტიპები:
- მომხმარებელი: ეძებს ხელოსანს, დებს მოთხოვნებს, სრულიად უფასოდ იყენებს პლატფორმას
- ხელოსანი: ასრულებს სამუშაოს, აქვს პროფილი/პორტფოლიო, სჭირდება ტარიფი
- კომპანია: გუნდი/ბრიგადა, სჭირდება ტარიფი
- სტაფი/ადმინი: საიტის მართვა

VIP სისტემა ხელოსნებისთვის:
- VIP: 2₾/1 დღე ან 10₾/5 დღე — სიის სათავეში ძიების შედეგებში
- VIP+: 4₾/1 დღე ან 18₾/5 დღე — ყოველთვის VIP-ზე მაღლა

VIP სისტემა კომპანიებისთვის:
- VIP: 5₾/1 დღე ან 25₾/5 დღე — სიის სათავეში
- VIP+: 10₾/1 დღე ან 50₾/5 დღე — სპეციალურ "🏢 კომპანიების" სექციაში გამოჩნდება

ტარიფები ხელოსნებისთვის:
- Start: 0₾ — 3 თვე უფასო, 5 შეთავაზება/თვეში. შემდეგ საჭიროა Pro ან TOP.
- Pro: 29₾/თვე — ულიმიტო შეთავაზებების გაგზავნა, მაღალი პოზიცია ძიებაში, ავტომატური განახლება
- TOP: 69₾/თვე — Pro-ს ყველა ფუნქცია + ყოველდღე ავტომატური VIP+ სტატუსი, სპეციალური TOP ბეჯი

ტარიფები კომპანიებისთვის:
- Start: 0₾ — 3 თვე უფასო, 5 შეთავაზება/თვეში
- Pro: 99₾/თვე — ულიმიტო შეთავაზებების გაგზავნა, მაღალი პოზიცია ძიებაში
- TOP: 159₾/თვე — ყველაფერი + ავტო VIP+ ყოველდღე + სპეციალური "🏢 კომპანიების" სექციაში გამოჩნდება

მნიშვნელოვანი: TOP ტარიფი ავტომატურად ააქტიურებს VIP+ სტატუსს მთელი გამოწერის ვადით.
კომპანიები VIP+ ან TOP ტარიფით გამოჩნდება ცალკე სექციაში "🔧 ხელოსნები" გვერდზე.

ყველა ტარიფი ავტომატურად განახლდება 30 დღეში თუ user არ გამორთავს auto-renewal-ს პირად ცენტრში.

გადახდა: TBC Pay-ით, ბარათის შენახვით. პლატფორმა არ ინახავს ბარათის სრულ მონაცემებს.

მომხმარებელი რომ აჭერს ხელი ხელოსნის/კომპანიის სახელს, მის პროფილზე გადადის. ჩათშიც იგივე ფუნქციონალია.

კონტაქტი: support@xelosani.ge

მნიშვნელოვანი ინსტრუქცია: როდესაც user-ი გკითხავს ტარიფების შესახებ, ყოველთვის მიუთითე მისი ანგარიშის ტიპი. თუ არ იცი — ჰკითხე პირდაპირ "ხელოსანი ხარ თუ კომპანია?". პასუხობ ყოველთვის ქართულად, მეგობრულად და ლაკონურად.

თუ ოპერატორი სჭირდება, უთხარი "ვაკავშირებ ოპერატორთან!" და დაამატე [OPERATOR_REQUEST] ბოლოში.`;

// ── Static greeting patterns (no API call needed) ─────────────
const GREETINGS = [
  /^გამარჯობა[!?.]*$/i,
  /^გამარჯობა\s*არია[!?.]*$/i,
  /^სალამი?[!?.]*$/i,
  /^hi+[!?.]*$/i,
  /^hello[!?.]*$/i,
  /^hey[!?.]*$/i,
  /^მოგესალმები[!?.]*$/i,
  /^ჰეი[!?.]*$/i,
];

const GREETING_REPLIES = [
  'გამარჯობა! 👋 მე ვარ ARIA — ხელოსანი.ge-ის ასისტენტი. როგორ დაგეხმარო?',
  'გამარჯობა! 😊 ARIA ვარ. შეგიძლია მკითხო ნებისმიერი კითხვა პლატფორმის შესახებ!',
  'სალამი! 👋 ARIA ვარ, მზად ვარ დაგეხმაროს. რა გაინტერესებს?',
];

function isGreeting(messages) {
  if (!messages || messages.length !== 1) return false;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return false;
  const text = (last.parts?.[0]?.text || last.text || '').trim();
  return GREETINGS.some((pattern) => pattern.test(text));
}

// POST /api/aria/chat
router.post('/chat', ariaLimiter, async (req, res) => {
  try {
    const { messages, userType } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages სავალდებულოა' });
    }

    // ✅ FIX 1: Return hardcoded reply for simple greetings — saves API tokens
    if (isGreeting(messages)) {
      const reply = GREETING_REPLIES[Math.floor(Math.random() * GREETING_REPLIES.length)];
      return res.json({ reply });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.startsWith('YOUR_')) {
      return res.status(503).json({ error: 'Gemini API key კონფიგურირებული არ არის' });
    }

    let safeMessages = messages
      .filter((m) => m.role === 'user' || m.role === 'model')
      .slice(-20)
      .map((m) => ({
        role: m.role,
        parts: [{ text: String(m.parts?.[0]?.text || m.text || '').substring(0, 2000) }],
      }));

    // Gemini requires conversation to start with 'user' role
    while (safeMessages.length > 0 && safeMessages[0].role === 'model') {
      safeMessages.shift();
    }
    if (safeMessages.length === 0) {
      return res.status(400).json({ error: 'messages სავალდებულოა' });
    }

    // Append user-type context to the system prompt so ARIA picks the right pricing
    let systemText = ARIA_SYSTEM;
    if (userType === 'user') {
      systemText += '\n\nმიმდინარე user: მომხმარებელი (უფასოდ იყენებს, არ სჭირდება ტარიფი/VIP).';
    } else if (userType === 'handyman') {
      systemText += '\n\nმიმდინარე user: ხელოსანი (ხელოსნის ფასები გამოიყენე პასუხებში).';
    } else if (userType === 'company') {
      systemText += '\n\nმიმდინარე user: კომპანია (კომპანიის ფასები გამოიყენე პასუხებში).';
    }

    const body = {
      system_instruction: { parts: [{ text: systemText }] },
      contents: safeMessages,
      generationConfig: {
        maxOutputTokens: 800,
        temperature: 0.7,
      },
    };

    // ✅ Gemini 2.5 Flash
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
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
