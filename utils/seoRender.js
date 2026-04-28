// utils/seoRender.js
// ════════════════════════════════════════════════════════════════
// Dynamic Rendering for SEO bots (Puppeteer)
// 
// Why: Fixi.ge is a SPA — Googlebot can render JS but takes 2-4 weeks,
// Facebook/Telegram/Twitter bots can NOT render JS at all.
// This middleware detects bots and serves them pre-rendered HTML.
//
// Strategy:
//   1. Detect bot via User-Agent
//   2. Use cached version if fresh (< 1 hour)
//   3. Otherwise render with Puppeteer (15s timeout)
//   4. Strip <script> tags from output (faster, lighter for bots)
//   5. Cache result
//
// Resource use: ~100MB RAM per Chrome instance, ~2s per render
// Recommended for production: install Chromium via apt or use chromium-browser
// ════════════════════════════════════════════════════════════════

let puppeteer;
try { puppeteer = require('puppeteer'); }
catch (_) { console.warn('[SEO RENDER] puppeteer not installed. Run: npm install puppeteer'); }

const { LRUCache } = (() => {
  try { return require('lru-cache'); }
  catch (_) {
    // Fallback: simple Map-based cache
    return { LRUCache: class { 
      constructor(opts){ this.max=opts.max||50; this.ttl=opts.ttl||3600000; this.m=new Map(); }
      get(k){ const v=this.m.get(k); if(!v) return; if(Date.now()-v.t>this.ttl){this.m.delete(k);return;} return v.d; }
      set(k,d){ if(this.m.size>=this.max) this.m.delete(this.m.keys().next().value); this.m.set(k,{d,t:Date.now()}); }
    }};
  }
})();

// Cache: 100 URLs × 1 hour TTL
const cache = new LRUCache({ max: 100, ttl: 60 * 60 * 1000 });

// ── Bot detection — only known SEO/social crawlers ─────────────
const BOT_REGEX = /googlebot|bingbot|yandex|baiduspider|duckduckbot|slurp|facebookexternalhit|facebot|twitterbot|linkedinbot|telegrambot|whatsapp|skypeuripreview|applebot|petalbot|semrushbot|ahrefsbot/i;

function isBot(userAgent) {
  if (!userAgent) return false;
  return BOT_REGEX.test(userAgent);
}

// ── Singleton browser instance (cheaper than launch per request) ──
let browserPromise = null;
async function getBrowser() {
  if (!puppeteer) return null;
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.connected) return b;
    } catch (_) {}
    browserPromise = null;
  }
  browserPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  });
  return browserPromise;
}

// ── Render a URL with Puppeteer ──
async function renderPage(url) {
  const browser = await getBrowser();
  if (!browser) throw new Error('Puppeteer not available');

  const page = await browser.newPage();
  try {
    // Block heavy resources to speed up rendering
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') req.abort();
      else req.continue();
    });

    // Set viewport + user agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (compatible; FixiSEORenderer/1.0)');

    // Navigate, wait for network to settle (max 12s)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 12000 });

    // Wait a bit more for late JS-rendered meta tags (showProfile/openRequestDetail)
    await page.waitForTimeout?.(800).catch?.(() => {}) ||
      new Promise(r => setTimeout(r, 800));

    // Get final HTML
    let html = await page.content();

    // Strip <script> tags — bots don't need JS, makes payload smaller
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

    return html;
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Express middleware ──
function seoMiddleware(req, res, next) {
  const ua = req.headers['user-agent'] || '';

  // Only intercept bots, GET requests, and HTML routes (not /api, not assets)
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  if (req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico|woff2?|map|json|xml|txt|pdf|mp4|webm)$/i)) return next();
  if (!isBot(ua)) return next();

  // Build full URL (use SITE_URL since bot might come via different host)
  const SITE = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  const fullUrl = SITE.replace(/\/$/, '') + req.originalUrl;

  // Check cache
  const cached = cache.get(fullUrl);
  if (cached) {
    res.set('X-SEO-Cache', 'HIT');
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(cached);
  }

  // Render with Puppeteer
  renderPage(fullUrl)
    .then(html => {
      cache.set(fullUrl, html);
      res.set('X-SEO-Cache', 'MISS');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    })
    .catch(err => {
      console.warn('[SEO RENDER] Failed:', fullUrl, err.message);
      // Fall through to normal SPA — bot will get raw HTML, still has meta tags from index.html
      next();
    });
}

// ── Graceful shutdown ──
async function closeSeoBrowser() {
  try {
    if (browserPromise) {
      const b = await browserPromise;
      await b.close();
    }
  } catch (_) {}
  browserPromise = null;
}

module.exports = { seoMiddleware, closeSeoBrowser, isBot };
