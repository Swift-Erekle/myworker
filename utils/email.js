// utils/email.js
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

const FROM = {
  email: process.env.SENDGRID_FROM_EMAIL || 'noreply@fixi.ge',
  name: 'Fixi.ge',
};

/**
 * Send an email via SendGrid
 */
async function sendEmail(to, subject, html) {
  if (!process.env.SENDGRID_API_KEY) {
    console.warn('[EMAIL] SENDGRID_API_KEY not set — email not sent:', { to, subject });
    return false;
  }
  try {
    await sgMail.send({ to, from: FROM, subject, html });
    return true;
  } catch (err) {
    console.error('[EMAIL] SendGrid error:', err?.response?.body || err.message);
    return false;
  }
}

// ── Base Template ────────────────────────────────────────────

function baseTemplate(content) {
  return `<!DOCTYPE html>
<html lang="ka">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fixi.ge</title></head>
<body style="margin:0;padding:0;background:#0f0f13;font-family:'Segoe UI',Arial,sans-serif">
<div style="max-width:520px;margin:40px auto;padding:32px;background:#1a1a24;border-radius:16px;border:1px solid #2e2e3f">
  <div style="margin-bottom:24px;text-align:center">
    <span style="font-size:28px;font-weight:900;color:#f0eff5">ხელოსანი<span style="color:#ff6b2b">.ge</span></span>
  </div>
  ${content}
  <div style="margin-top:32px;padding-top:20px;border-top:1px solid #2e2e3f;text-align:center;font-size:11px;color:#9998b0">
    Fixi.ge · support@fixi.ge · <a href="${process.env.SITE_URL}" style="color:#ff6b2b">fixi.ge</a>
  </div>
</div>
</body></html>`;
}

// ── Templates ────────────────────────────────────────────────

function emailVerifyTemplate(name, code) {
  return baseTemplate(`
    <h2 style="color:#f0eff5;font-size:20px;margin-bottom:8px">👋 გამარჯობა, ${name}!</h2>
    <p style="color:#9998b0;font-size:14px;line-height:1.6">შენი ანგარიშის დასადასტურებლად გამოიყენე ეს 6-ნიშნა კოდი:</p>
    <div style="margin:24px 0;padding:20px;background:#0f0f13;border-radius:12px;text-align:center">
      <div style="font-size:42px;font-weight:900;letter-spacing:14px;color:#ff6b2b;font-family:monospace">${code}</div>
    </div>
    <p style="color:#9998b0;font-size:12px;text-align:center">კოდი მოქმედებს <strong style="color:#f0eff5">15 წუთის</strong> განმავლობაში.</p>
    <p style="color:#9998b0;font-size:12px;text-align:center">თუ ეს შენ არ ხარ, უგულებელყოფ ამ ელ-ფოსტას.</p>
  `);
}

function passwordResetTemplate(name, code) {
  return baseTemplate(`
    <h2 style="color:#f0eff5;font-size:20px;margin-bottom:8px">🔑 პაროლის აღდგენა</h2>
    <p style="color:#9998b0;font-size:14px">გამარჯობა, ${name}! პაროლის შესაცვლელად გამოიყენე:</p>
    <div style="margin:24px 0;padding:20px;background:#0f0f13;border-radius:12px;text-align:center">
      <div style="font-size:42px;font-weight:900;letter-spacing:14px;color:#ff6b2b;font-family:monospace">${code}</div>
    </div>
    <p style="color:#9998b0;font-size:12px;text-align:center">კოდი მოქმედებს <strong style="color:#f0eff5">15 წუთის</strong> განმავლობაში.</p>
    <p style="color:#e74c3c;font-size:12px;text-align:center">⚠️ თუ ეს შენ არ მოითხოვე, შეგვატყობინე: support@fixi.ge</p>
  `);
}

function vipConfirmTemplate(name, vipType, days, amount) {
  const label = vipType === 'vipp' ? '💜 VIP+' : '⭐ VIP';
  const price = (amount / 100).toFixed(2);
  return baseTemplate(`
    <h2 style="color:#f0eff5;font-size:20px;margin-bottom:8px">${label} ჩართულია!</h2>
    <p style="color:#9998b0;font-size:14px">გამარჯობა, ${name}! შენი VIP სტატუსი წარმატებით გააქტიურდა.</p>
    <div style="margin:24px 0;padding:20px;background:#0f0f13;border-radius:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="color:#9998b0">პაკეტი:</span>
        <span style="color:#f0eff5;font-weight:700">${label}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span style="color:#9998b0">ვადა:</span>
        <span style="color:#f0eff5;font-weight:700">${days} დღე</span>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span style="color:#9998b0">გადახდა:</span>
        <span style="color:#ff6b2b;font-weight:700;font-size:18px">₾${price}</span>
      </div>
    </div>
    <p style="color:#9998b0;font-size:13px;text-align:center">ახლა შენი პროფილი სიის სათავეში გამოჩნდება! 🚀</p>
  `);
}

// ✅ NEW: Subscription confirmation email
function subConfirmTemplate(name, plan, expiresAt, amount) {
  const label = plan === 'top' ? '🔝 TOP' : '⚡ Pro';
  const price = (amount / 100).toFixed(2);
  const expDate = expiresAt ? new Date(expiresAt).toLocaleDateString('ka-GE') : '—';
  const planFeatures = plan === 'top'
    ? ['ულიმიტო შეთავაზებები', 'ავტო VIP+ (ყოველ დღე პირველი)', 'TOP ბეჯი', 'ავტო-განახლება 30 დღეში']
    : ['ულიმიტო შეთავაზებები', 'გაუმჯობესებული პოზიცია', 'Pro ბეჯი', 'ავტო-განახლება 30 დღეში'];

  return baseTemplate(`
    <h2 style="color:#f0eff5;font-size:20px;margin-bottom:8px">${label} ტარიფი ჩართულია! 🎉</h2>
    <p style="color:#9998b0;font-size:14px">გამარჯობა, ${name}! შენი გამოწერა წარმატებით გააქტიურდა.</p>
    <div style="margin:20px 0;padding:20px;background:#0f0f13;border-radius:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:10px">
        <span style="color:#9998b0">ტარიფი:</span>
        <span style="color:#f0eff5;font-weight:800;font-size:16px">${label}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:10px">
        <span style="color:#9998b0">ვადა:</span>
        <span style="color:#f0eff5;font-weight:700">${expDate}-მდე</span>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span style="color:#9998b0">გადახდა:</span>
        <span style="color:#ff6b2b;font-weight:700;font-size:18px">₾${price}</span>
      </div>
    </div>
    <div style="margin:16px 0;padding:16px;background:#0f172a;border-radius:10px;border:1px solid rgba(255,107,43,.2)">
      <div style="font-size:12px;color:#9998b0;margin-bottom:8px;font-weight:600">✅ შენი შესაძლებლობები:</div>
      ${planFeatures.map(f => `<div style="font-size:13px;color:#f0eff5;margin-bottom:4px">• ${f}</div>`).join('')}
    </div>
    <p style="color:#9998b0;font-size:11px;text-align:center">ტარიფი ავტომატურად განახლდება 30 დღეში. გასათიშად: პარამეტრები → ბარათი → ავტო-განახლება.</p>
  `);
}

// ✅ NEW: Auto-renewal failure notification
function renewalFailedTemplate(name, plan, expiresAt) {
  const label = plan === 'top' ? '🔝 TOP' : '⚡ Pro';
  const expDate = expiresAt ? new Date(expiresAt).toLocaleDateString('ka-GE') : '—';
  return baseTemplate(`
    <h2 style="color:#e74c3c;font-size:20px;margin-bottom:8px">⚠️ ავტო-განახლება ვერ მოხდა</h2>
    <p style="color:#9998b0;font-size:14px">გამარჯობა, ${name}! სამწუხაროდ ვერ მოხდა ${label} ტარიფის ავტო-განახლება.</p>
    <p style="color:#9998b0;font-size:14px;margin-top:12px">ტარიფი გაუქმდება <strong style="color:#e74c3c">${expDate}-ს</strong>.</p>
    <div style="margin:20px 0;text-align:center">
      <a href="${process.env.SITE_URL}/card" style="display:inline-block;padding:12px 24px;background:#ff6b2b;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">💳 ბარათის განახლება</a>
    </div>
    <p style="color:#9998b0;font-size:12px;text-align:center">დახმარება: support@fixi.ge</p>
  `);
}

module.exports = {
  sendEmail,
  emailVerifyTemplate,
  passwordResetTemplate,
  vipConfirmTemplate,
  subConfirmTemplate,
  renewalFailedTemplate,
};
