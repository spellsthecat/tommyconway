/* ============================================================
   Conway Sales HQ — backend
   - Serves the admin SPA (public/)
   - JSON-file data store with simple REST CRUD
   - AI proxy (Anthropic or OpenAI, chosen via env)
   - News fetcher (RSS/Atom, server-side, cached)
   - Optional HTTP Basic Auth to lock the whole thing down
   Node 18+ (uses global fetch). No build step.
   ============================================================ */
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

/* ---------- minimal .env loader (no dependency) ---------- */
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) return;
      let [, k, v] = m;
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    });
  } catch (e) { console.error('[env] could not read .env:', e.message); }
})();

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'store.json');
const SEED  = path.join(DATA_DIR, 'seed.json');

app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1); // behind Caddy / Cloudflare

/* ---------- optional basic auth (protect everything) ---------- */
const AUTH_USER = process.env.ADMIN_USER;
const AUTH_PASS = process.env.ADMIN_PASS;
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    const [type, cred] = h.split(' ');
    if (type === 'Basic' && cred) {
      const [u, p] = Buffer.from(cred, 'base64').toString().split(':');
      if (u === AUTH_USER && p === AUTH_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Conway Sales HQ"');
    return res.status(401).send('Authentication required.');
  });
  console.log('[auth] Basic auth is ON');
} else {
  console.log('[auth] Basic auth is OFF (set ADMIN_USER & ADMIN_PASS to enable)');
}

/* ---------- data store ---------- */
const COLLECTIONS = ['deals', 'clients', 'products', 'competitors', 'leads', 'plans', 'intel', 'drafts'];
function freshStore() {
  const o = { settings: {} };
  COLLECTIONS.forEach(c => (o[c] = []));
  return o;
}
function loadStore() {
  try {
    if (!fs.existsSync(STORE)) {
      const seed = fs.existsSync(SEED) ? JSON.parse(fs.readFileSync(SEED, 'utf8')) : freshStore();
      fs.writeFileSync(STORE, JSON.stringify(seed, null, 2));
      return seed;
    }
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch (e) {
    console.error('[store] load failed, starting fresh:', e.message);
    return freshStore();
  }
}
let db = loadStore();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STORE, JSON.stringify(db, null, 2)); }
    catch (e) { console.error('[store] save failed:', e.message); }
  }, 150);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- health ---------- */
const AI_PROVIDER = (process.env.AI_PROVIDER || '').toLowerCase();
const AI_KEY = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || (AI_PROVIDER === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-sonnet-latest');
const aiConfigured = !!(AI_KEY && (AI_PROVIDER === 'anthropic' || AI_PROVIDER === 'openai' ||
  (process.env.ANTHROPIC_API_KEY) || (process.env.OPENAI_API_KEY)));
function providerName() {
  if (AI_PROVIDER) return AI_PROVIDER;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return '';
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0',
    ai: { configured: aiConfigured, provider: providerName(), model: aiConfigured ? AI_MODEL : null } });
});

/* ---------- whole store ---------- */
app.get('/api/store', (req, res) => res.json(db));

/* ---------- settings ---------- */
app.get('/api/settings', (req, res) => res.json(db.settings || {}));
app.put('/api/settings', (req, res) => {
  db.settings = { ...(db.settings || {}), ...(req.body || {}) };
  save(); res.json(db.settings);
});

/* ============================================================
   AI proxy
   ============================================================ */
app.post('/api/ai', async (req, res) => {
  if (!aiConfigured) return res.status(400).json({ error: 'AI is not configured. Add an API key in server/.env and restart.' });
  const { system, messages, prompt, max_tokens } = req.body || {};
  const msgs = messages && messages.length ? messages : (prompt ? [{ role: 'user', content: prompt }] : null);
  if (!msgs) return res.status(400).json({ error: 'Provide messages or a prompt.' });
  const provider = providerName();
  try {
    let text;
    if (provider === 'openai') text = await callOpenAI(system, msgs, max_tokens);
    else text = await callAnthropic(system, msgs, max_tokens);
    res.json({ text });
  } catch (e) {
    console.error('[ai] error:', e.message);
    res.status(502).json({ error: 'AI request failed: ' + e.message });
  }
});

async function callAnthropic(system, messages, max_tokens) {
  const key = process.env.ANTHROPIC_API_KEY || AI_KEY;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: AI_MODEL, max_tokens: max_tokens || 1200,
      system: system || undefined,
      messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })),
    }),
  });
  if (!r.ok) throw new Error('Anthropic ' + r.status + ' ' + (await safeErr(r)));
  const j = await r.json();
  return (j.content || []).map(b => b.text || '').join('').trim();
}
async function callOpenAI(system, messages, max_tokens) {
  const key = process.env.OPENAI_API_KEY || AI_KEY;
  const full = [];
  if (system) full.push({ role: 'system', content: system });
  messages.forEach(m => full.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: AI_MODEL, max_tokens: max_tokens || 1200, messages: full }),
  });
  if (!r.ok) throw new Error('OpenAI ' + r.status + ' ' + (await safeErr(r)));
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}
async function safeErr(r) { try { const j = await r.json(); return (j.error?.message || JSON.stringify(j)).slice(0, 200); } catch { return ''; } }

/* ============================================================
   News (RSS/Atom) — server-side fetch + parse + cache
   ============================================================ */
// Google News RSS query builder (reliable; supports site: and boolean operators)
const gn = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en';
const DEFAULT_FEEDS = [
  // --- Flooring trade publications (via Google News, so no fragile site RSS needed) ---
  gn('commercial flooring site:floordaily.net'),
  gn('commercial flooring site:floortrendsmag.com'),
  gn('flooring site:fcnews.net OR site:floorcoveringnews.net'),
  gn('flooring commercial interiors site:interiorsandsources.com OR site:contractdesign.com'),
  // --- A direct WordPress feed as a bonus source (skipped gracefully if unavailable) ---
  'https://floordaily.net/feed/',
  // --- Milliken's world: categories & what Tom sells ---
  gn('"carpet tile" OR "modular flooring" commercial'),
  gn('commercial flooring sustainability PVC-free OR "Red List" OR EPD OR Declare'),
  gn('commercial "resilient flooring" OR "luxury vinyl tile" specification'),
  // --- Competitive set (incl. Milliken) ---
  gn('Milliken flooring OR Interface flooring OR Tarkett OR "Mohawk Group" OR "Shaw Contract" OR Patcraft'),
  // --- Tom's sectors ---
  gn('senior living OR healthcare flooring commercial interior design'),
  gn('student housing OR multifamily flooring design'),
  gn('workplace office design flooring specification architecture'),
];
let newsCache = { items: [], fetchedAt: 0 };
const NEWS_TTL = 15 * 60 * 1000;

app.get('/api/news', async (req, res) => {
  const refresh = req.query.refresh === '1';
  if (!refresh && newsCache.items.length && Date.now() - newsCache.fetchedAt < NEWS_TTL) {
    return res.json(newsCache);
  }
  const feeds = (db.settings && db.settings.feeds && db.settings.feeds.length) ? db.settings.feeds : DEFAULT_FEEDS;
  try {
    const results = await Promise.allSettled(feeds.map(f => fetchFeed(f)));
    let items = [];
    results.forEach(r => { if (r.status === 'fulfilled') items = items.concat(r.value); });
    // dedupe by title, sort by date desc
    const seen = new Set();
    items = items.filter(it => { const k = (it.title || '').toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; });
    items.sort((a, b) => (new Date(b.date || 0)) - (new Date(a.date || 0)));
    newsCache = { items: items.slice(0, 40), fetchedAt: Date.now() };
    res.json(newsCache);
  } catch (e) {
    res.status(502).json({ error: 'Could not fetch feeds: ' + e.message, items: newsCache.items, fetchedAt: newsCache.fetchedAt });
  }
});

async function fetchFeed(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'ConwaySalesHQ/1.0 (+rss reader)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = await r.text();
    return parseFeed(xml);
  } finally { clearTimeout(t); }
}
function parseFeed(xml) {
  const out = [];
  const grab = (block, tag) => {
    const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
    return m ? decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
  };
  const source = decode((xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/ - Google News$/, '').trim();
  // RSS items
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  items.forEach(b => {
    const link = grab(b, 'link') || (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [, ''])[1];
    out.push({ title: grab(b, 'title'), link, date: grab(b, 'pubDate') || grab(b, 'dc:date'),
      summary: grab(b, 'description'), source: cleanSource(grab(b, 'source') || source) });
  });
  // Atom entries
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  entries.forEach(b => {
    const link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [, ''])[1] || grab(b, 'id');
    out.push({ title: grab(b, 'title'), link, date: grab(b, 'updated') || grab(b, 'published'),
      summary: grab(b, 'summary') || grab(b, 'content'), source });
  });
  return out.filter(x => x.title);
}
function cleanSource(s) { return (s || '').replace(/<[^>]+>/g, '').trim(); }
function decode(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

/* ============================================================
   Generic CRUD — registered AFTER the specific /api routes above
   so it never shadows /api/ai, /api/news, /api/health, etc.
   ============================================================ */
function guard(req, res, next) {
  if (!COLLECTIONS.includes(req.params.col)) return res.status(404).json({ error: 'Unknown collection' });
  next();
}
app.get('/api/:col', guard, (req, res) => res.json(db[req.params.col] || []));
app.post('/api/:col', guard, (req, res) => {
  const item = { id: uid(), createdAt: Date.now(), ...(req.body || {}) };
  db[req.params.col].push(item); save(); res.status(201).json(item);
});
app.put('/api/:col/:id', guard, (req, res) => {
  const arr = db[req.params.col];
  const i = arr.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  arr[i] = { ...arr[i], ...(req.body || {}), id: arr[i].id, updatedAt: Date.now() };
  save(); res.json(arr[i]);
});
app.delete('/api/:col/:id', guard, (req, res) => {
  const arr = db[req.params.col];
  const i = arr.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  arr.splice(i, 1); save(); res.status(204).end();
});

/* ---------- static SPA ---------- */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Conway Sales HQ running  →  http://localhost:${PORT}`);
    console.log(`  AI: ${aiConfigured ? providerName() + ' / ' + AI_MODEL : 'not configured'}`);
    console.log(`  Data: ${STORE}\n`);
  });
}

// Exported for testing (no side effects when imported)
module.exports = { app, parseFeed, decode, cleanSource };
