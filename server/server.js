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

/* ---------- single-password login (cookie session; no username) ---------- */
const crypto = require('crypto');
const AUTH_PASS = process.env.ADMIN_PASS;
const AUTH_ON = !!AUTH_PASS;
const TOKEN = AUTH_ON ? crypto.createHash('sha256').update('conway-hq::' + AUTH_PASS).digest('hex') : '';
const OPEN_PATHS = new Set(['/login', '/api/login', '/manifest.webmanifest', '/sw.js', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/favicon.ico']);
function parseCookies(req) {
  const h = req.headers.cookie || ''; const o = {};
  h.split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return o;
}
const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Conway Sales HQ</title><meta name="theme-color" content="#3f6151"/>
<link rel="apple-touch-icon" href="/icon-180.png"/><link rel="manifest" href="/manifest.webmanifest"/>
<meta name="apple-mobile-web-app-capable" content="yes"/><meta name="apple-mobile-web-app-title" content="Conway HQ"/>
<style>*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:linear-gradient(160deg,#2c4639,#15201a);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#eef2ef;padding:24px}
.box{width:100%;max-width:340px;text-align:center}.mark{width:64px;height:64px;border-radius:16px;background:#3f6151;display:grid;place-items:center;margin:0 auto 18px;font-weight:700;font-size:22px;color:#fff;box-shadow:0 10px 30px -10px rgba(0,0,0,.5)}
h1{font-size:19px;margin:0 0 4px;font-weight:650}p{margin:0 0 22px;color:#aebcb2;font-size:13.5px}
input{width:100%;padding:13px 14px;border-radius:12px;border:1px solid #3c5346;background:#1c2a22;color:#fff;font-size:16px;outline:none}
input:focus{border-color:#6f9a84}button{width:100%;margin-top:12px;padding:13px;border:0;border-radius:12px;background:#6f9a84;color:#13201a;font-weight:700;font-size:15px;cursor:pointer}
button:active{transform:translateY(1px)}.err{color:#ffb4b4;font-size:13px;margin-top:12px;min-height:16px}</style></head>
<body><div class="box"><div class="mark">TC</div><h1>Conway Sales HQ</h1><p>Enter your password to continue.</p>
<form id="f"><input id="pw" type="password" autocomplete="current-password" placeholder="Password" autofocus/>
<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>
<script>const f=document.getElementById('f'),pw=document.getElementById('pw'),e=document.getElementById('e');
f.addEventListener('submit',async ev=>{ev.preventDefault();e.textContent='';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})});if(r.ok){location.href='/';}else{e.textContent='That password didn\\'t work.';pw.select();}}catch(x){e.textContent='Something went wrong — try again.';}});</script>
</body></html>`;
if (AUTH_ON) {
  app.get('/login', (req, res) => res.type('html').send(LOGIN_HTML));
  app.post('/api/login', (req, res) => {
    const pw = (req.body && req.body.password) || '';
    if (pw === AUTH_PASS) {
      res.cookie('conway_auth', TOKEN, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 1000 * 60 * 60 * 24 * 180 });
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: 'Wrong password' });
  });
  app.post('/api/logout', (req, res) => { res.clearCookie('conway_auth'); res.json({ ok: true }); });
  app.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path)) return next();
    if (parseCookies(req).conway_auth === TOKEN) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  });
  console.log('[auth] Single-password login is ON');
} else {
  console.log('[auth] Login is OFF (set ADMIN_PASS to enable)');
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

// Small helper so brief/prep can reuse whichever provider is configured.
async function aiText(system, userContent, max_tokens) {
  const provider = providerName();
  const msgs = [{ role: 'user', content: userContent }];
  if (provider === 'openai') return await callOpenAI(system, msgs, max_tokens);
  return await callAnthropic(system, msgs, max_tokens);
}

const MILLIKEN_CONTEXT =
  'Tom sells Milliken commercial flooring. Portfolio: carpet tile (incl. PrintWorks custom print), ' +
  'resilient/LVT, broadloom & rugs, OBEX entrance flooring, HybridFORM, installation + quick-ship products. ' +
  'Key differentiators: WellBAC cushion backing (up to 24% less muscle fatigue, acoustics + moisture management, ' +
  'up to 50% longer life vs hardback), PrintWorks design flexibility; sustainability via M/PACT (carbon-offset tiles), ' +
  'N/XT Life reclamation/second-life, PVC-free, verified Red List Free; plus design consultation, custom development, ' +
  'installation, reclamation and CEU training. Sectors: workplace, healthcare, senior living & multifamily, education, ' +
  'government, hospitality. Main competitors: Shaw Contract, Patcraft, Mohawk Group, Interface, Tarkett, Mannington.';

// AI daily brief — turns current headlines + pipeline into a tight morning plan.
app.post('/api/brief', async (req, res) => {
  if (!aiConfigured) return res.status(400).json({ error: 'AI is not configured. Add an API key in server/.env and restart.' });
  const { headlines = [], pipeline = [], context = '' } = req.body || {};
  const hl = headlines.slice(0, 25).map(h => `- ${h.title}${h.source ? ' (' + h.source + ')' : ''}`).join('\n');
  const pl = pipeline.slice(0, 15).map(d => `- ${d.client || d.name || 'Deal'}: ${d.stage || d.status || ''}${d.value ? ' ($' + d.value + ')' : ''}`).join('\n');
  try {
    const text = await aiText(
      'You are the sales chief of staff for a commercial flooring Global Account Manager at Milliken. Be concise, specific and action-oriented. ' + MILLIKEN_CONTEXT,
      `Write this morning's brief for Tom. Use these sections exactly:\n` +
      `**Top 3 moves today** — concrete, named actions.\n` +
      `**Headlines that matter** — 3-5 items, each with one line on why it matters to a flooring GAM and an angle to use.\n` +
      `**Pipeline nudges** — who to touch and why.\nKeep it tight; no fluff.\n\n` +
      `HEADLINES:\n${hl || '(none loaded)'}\n\nPIPELINE:\n${pl || '(none)'}\n\n${context}`,
      900);
    res.json({ text });
  } catch (e) { res.status(502).json({ error: 'Brief failed: ' + e.message }); }
});

// AI meeting prep — a one-pager for a selected contact/account.
app.post('/api/prep', async (req, res) => {
  if (!aiConfigured) return res.status(400).json({ error: 'AI is not configured. Add an API key in server/.env and restart.' });
  const { contact = {}, headlines = [] } = req.body || {};
  const hl = headlines.slice(0, 12).map(h => `- ${h.title}`).join('\n');
  try {
    const text = await aiText(
      'You prep a Milliken commercial flooring account manager for meetings with architects, designers and corporate accounts. Be specific and brief. ' + MILLIKEN_CONTEXT,
      `Build a one-page meeting prep. Use these sections:\n` +
      `**Who / what** — one line.\n**Openers** — 2-3 tailored talking points.\n` +
      `**What to bring** — specific Milliken assets (samples, CEUs, EPD/Red List Free proof, WellBAC/PrintWorks/M-PACT story, sector case studies).\n` +
      `**The ask** — the single thing that advances this.\n\n` +
      `CONTACT / ACCOUNT:\n${JSON.stringify(contact).slice(0, 1500)}\n\nRECENT RELEVANT HEADLINES:\n${hl || '(none)'}`,
      800);
    res.json({ text });
  } catch (e) { res.status(502).json({ error: 'Prep failed: ' + e.message }); }
});

/* ============================================================
   News (RSS/Atom) — server-side fetch + parse + cache
   ============================================================ */
// Google News RSS query builder (reliable; supports site: and boolean operators)
const gn = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en';

// An account-trigger query: real-estate / expansion signals that mean a floor
// may be specified soon. Fed by Tom's watchlist (editable in Settings).
const triggerQuery = name =>
  gn(`"${name}" (headquarters OR campus OR office OR expansion OR renovation OR "new facility" OR relocation OR lease OR "breaks ground" OR "ground breaking")`);

// Sensible default target accounts (Tom can edit these in Settings → Watchlist).
const DEFAULT_ACCOUNTS = ['Nike', 'Meta', 'Amazon', 'Google', 'senior living developer', 'airport terminal'];

// Free, categorized intel feeds. Everything here runs through Google News RSS
// (no paid data), so it costs nothing and never needs an API key.
const FEED_GROUPS = {
  trade: { label: 'Flooring trade', feeds: [
    gn('commercial flooring site:floordaily.net'),
    gn('flooring site:fcnews.net OR site:floorcoveringnews.net'),
    gn('commercial flooring site:floortrendsmag.com'),
    'https://floordaily.net/feed/',
  ]},
  competitive: { label: 'Competitors', feeds: [
    gn('"Shaw Contract" OR Patcraft OR "Mohawk Group" flooring'),
    gn('Interface flooring OR Tarkett OR Mannington OR Milliken flooring'),
  ]},
  sustainability: { label: 'Sustainability & compliance', feeds: [
    gn('commercial flooring EPD OR HPD OR "Declare label" OR "Red List"'),
    gn('"embodied carbon" OR "Buy Clean" OR "PVC-free" building materials flooring'),
  ]},
  sectors: { label: 'Sectors', feeds: [
    gn('airport terminal OR aviation flooring OR "terminal renovation" design'),
    gn('senior living OR healthcare construction flooring design'),
    gn('corporate office "return to office" OR workplace renovation design flooring'),
    gn('"higher education" OR "K-12" school construction bond flooring'),
    gn('multifamily OR "student housing" development flooring design'),
  ]},
  indicators: { label: 'Market indicators', feeds: [
    gn('"Architecture Billings Index" AIA'),
    gn('nonresidential construction spending outlook'),
    gn('office vacancy OR commercial real estate construction outlook'),
  ]},
  trends: { label: 'Design trends', feeds: [
    gn('commercial interior design trends carpet OR flooring'),
    gn('NeoCon commercial interiors flooring'),
  ]},
  events: { label: 'Industry events', feeds: [
    gn('NeoCon OR "HD Expo" OR "Healthcare Design" OR "Environments for Aging" conference'),
  ]},
};

// The ordered list of category tabs the UI shows (Account triggers first).
const NEWS_GROUPS = [
  { key: 'triggers', label: 'Account triggers' },
  ...Object.entries(FEED_GROUPS).map(([key, g]) => ({ key, label: g.label })),
];

// Assemble the full tagged feed list for a fetch: watchlist triggers + the
// static groups + any custom feeds the user added in Settings.
function buildFeeds() {
  const accounts = (db.settings && Array.isArray(db.settings.accounts) && db.settings.accounts.length)
    ? db.settings.accounts : DEFAULT_ACCOUNTS;
  const list = [];
  accounts.forEach(a => { if (a) list.push({ url: triggerQuery(a), category: 'triggers', label: 'Account triggers', tag: a }); });
  Object.entries(FEED_GROUPS).forEach(([key, g]) => g.feeds.forEach(u => list.push({ url: u, category: key, label: g.label })));
  ((db.settings && db.settings.feeds) || []).forEach(u => { if (u) list.push({ url: u, category: 'custom', label: 'My feeds' }); });
  return list;
}

let newsCache = { items: [], fetchedAt: 0, groups: NEWS_GROUPS };
const NEWS_TTL = 15 * 60 * 1000;

app.get('/api/news', async (req, res) => {
  const refresh = req.query.refresh === '1';
  if (!refresh && newsCache.items.length && Date.now() - newsCache.fetchedAt < NEWS_TTL) {
    return res.json(newsCache);
  }
  const feeds = buildFeeds();
  try {
    const results = await Promise.allSettled(feeds.map(f =>
      fetchFeed(f.url).then(items => items.map(it => ({ ...it, category: f.category, categoryLabel: f.label, tag: f.tag || '' })))
    ));
    let items = [];
    results.forEach(r => { if (r.status === 'fulfilled') items = items.concat(r.value); });
    // dedupe by title, sort by date desc
    const seen = new Set();
    items = items.filter(it => { const k = (it.title || '').toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; });
    items.sort((a, b) => (new Date(b.date || 0)) - (new Date(a.date || 0)));
    // which categories actually returned anything (for the UI tabs)
    const present = new Set(items.map(i => i.category));
    const groups = NEWS_GROUPS.filter(g => present.has(g.key));
    newsCache = { items: items.slice(0, 150), fetchedAt: Date.now(), groups };
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
