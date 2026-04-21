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
- მომხმარებელი: ეძებს ხელოსანს, დებს მოთხოვნებს
- ხელოსანი: ასრულებს სამუშაოს, აქვს პროფილი/პორტფოლიო
- კომპანია: გუნდი/ბრიგადა
- სტაფი/ადმინი: საიტის მართვა

VIP სისტემა:
- VIP: 2₾/1 დღე ან 10₾/5 დღე — სიის სათავეში
- VIP+: 4₾/1 დღე ან 18₾/5 დღე — ყოველთვის VIP-ზე მაღლა

ტარიფები ხელოსნებისთვის: Start (0₾, 3 თვე), Pro (30₾/თვე), TOP (70₾/თვე).
მომხმარებლებისთვის: სრულიად უფასო.

კონტაქტი: support@xelosani.ge

პასუხობ ყოველთვის ქართულად, მეგობრულად და ლაკონურად.
თუ ოპერატორი სჭირდება, უთხარი "ვაკავშირებ ოპერატორთან!" და დაამატე [OPERATOR_REQUEST] ბოლოში.`;

// POST /api/aria/chat
router.post('/chat', ariaLimiter, async (req, res) => {
  try {
    const { messages } = req.body; // [{role:'user'|'model', parts:[{text}]}]
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages სავალდებულოა' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.startsWith('YOUR_')) {
      return res.status(503).json({ error: 'Gemini API key კონფიგურირებული არ არის' });
    }

    // Sanitize: only allow user/model roles, limit history
    let safeMessages = messages
      .filter((m) => m.role === 'user' || m.role === 'model')
      .slice(-20) // last 20 turns max
      .map((m) => ({
        role: m.role,
        parts: [{ text: String(m.parts?.[0]?.text || m.text || '').substring(0, 2000) }],
      }));

    // CRITICAL FIX: Gemini requires conversation to START with 'user' role.
    // Remove any leading 'model' messages (caused by ARIA greeting being added first).
    while (safeMessages.length > 0 && safeMessages[0].role === 'model') {
      safeMessages.shift();
    }
    if (safeMessages.length === 0) {
      return res.status(400).json({ error: 'messages სავალდებულოა' });
    }

    const body = {
      system_instruction: { parts: [{ text: ARIA_SYSTEM }] },
      contents: safeMessages,
      generationConfig: {
        maxOutputTokens: 800,
        temperature: 0.7,
      },
    };

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
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
