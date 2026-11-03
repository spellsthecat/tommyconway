# tommyconway.net

Two things in one repo:

| What | Where it runs | Folder |
|------|---------------|--------|
| **Public landing page** | `tommyconway.net` | `landing/` — plain static HTML + Tom's photo |
| **AI sales command center** | `admin.tommyconway.net` | `server/` — Node app (dashboard + AI + news) |

The admin side is a private dashboard for Tom: pipeline, clients/A&D, lead gen,
an AI email studio, a strategy chat grounded in his pipeline, an intel
summarizer, plans, a flooring-industry news feed, competitors and a product
line card. Data lives in a single JSON file (`server/data/store.json`) — easy to
back up, easy to move to a real database later.

---

## 1. Try it locally first (2 minutes)

You need **Node 18+**.

```bash
cd server
npm install
cp .env.example .env        # (optional) add an AI key — see §4
npm start
```

Open <http://localhost:3000>. The dashboard loads with example data you can edit
or delete. The AI buttons stay dormant until you add a key; everything else works
without one.

The landing page is just a file — open `landing/index.html` in a browser to see it.

---

## 2. Deploy to DigitalOcean (recommended, always-on)

### a) Create the droplet
- In your DigitalOcean project, create a **Droplet** → Ubuntu 24.04, the cheapest
  **$6/mo** shared-CPU size is plenty. Add your SSH key.
- Note the droplet's **public IPv4** address.

### b) Point the domain at it (DNS stays at Namecheap)
In Namecheap → **Domain List → Manage → Advanced DNS**, add these records
(leave the default Namecheap parking/CNAME records removed):

| Type  | Host    | Value                | TTL      |
|-------|---------|----------------------|----------|
| A     | `@`     | `YOUR_DROPLET_IP`    | Automatic |
| A     | `www`   | `YOUR_DROPLET_IP`    | Automatic |
| A     | `admin` | `YOUR_DROPLET_IP`    | Automatic |

DNS can take anywhere from a few minutes to a couple of hours to propagate.
(Prefer to manage DNS inside DigitalOcean instead? Point Namecheap's nameservers
to `ns1.digitalocean.com`, `ns2…`, `ns3…`, then add the same A records in DO's
Networking → Domains. Either way works — don't do both.)

### c) Put the files on the droplet
From your laptop (or clone from GitHub on the droplet — see §6):

```bash
# from inside this project folder, on your laptop:
rsync -av --exclude node_modules ./ root@YOUR_DROPLET_IP:/var/www/tommyconway/
```

### d) Install Node + Caddy on the droplet
```bash
ssh root@YOUR_DROPLET_IP

# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Caddy (web server + automatic HTTPS)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

### e) Configure and start the app
```bash
cd /var/www/tommyconway/server
npm install --omit=dev
cp .env.example .env
nano .env                     # add your AI key + a strong ADMIN_PASS (see §4 & §5)

# run it as a service that restarts on crash/reboot
cp /var/www/tommyconway/deploy/conway-hq.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now conway-hq
systemctl status conway-hq    # should say "active (running)"
```

### f) Turn on the web server + HTTPS
```bash
cp /var/www/tommyconway/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy automatically fetches HTTPS certificates. In a minute or two:
- **https://tommyconway.net** → Tom's landing page
- **https://admin.tommyconway.net** → the dashboard (asks for the password you set)

Done. ✅

---

## 3. Alternative: host locally on your Opti box + Cloudflare Tunnel (great for proof-of-concept)

No open ports, no exposed IP, free. Run the app on your local machine and let
Cloudflare tunnel the domain to it.

```bash
# on the Opti box
cd server && npm install && npm start      # app on :3000

# install cloudflared, then:
cloudflared tunnel login
cloudflared tunnel create conway
cloudflared tunnel route dns conway admin.tommyconway.net
# map the hostname to your local app in ~/.cloudflared/config.yml:
#   ingress:
#     - hostname: admin.tommyconway.net
#       service: http://localhost:3000
#     - service: http_status:404
cloudflared tunnel run conway
```

For this to work the domain's DNS needs to be on **Cloudflare** (add the site in
Cloudflare, then set Namecheap's nameservers to the two Cloudflare gives you).
You can serve the static landing page the same way (point it at a tiny static
server) or just host the landing page on DigitalOcean/Netlify and only tunnel the
admin app. When you're ready for always-on, move to the DigitalOcean setup above.

---

## 4. Turn on the AI

The assistant, email drafting, summaries, strategy chat and daily brief all run
through whichever provider you configure. Edit `server/.env`:

```ini
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
# AI_MODEL=claude-3-5-sonnet-latest   # optional override
```

…or use OpenAI:

```ini
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
# AI_MODEL=gpt-4o-mini
```

Restart the app after changing it (`systemctl restart conway-hq`). The key lives
only on the server, never in the browser. Settings → AI engine shows whether it's
connected.

---

## 5. Lock it down (important — it's a public URL)

`admin.tommyconway.net` is reachable by anyone who knows the address. Set a
username and a **long, random** password in `server/.env`:

```ini
ADMIN_USER=tom
ADMIN_PASS=some-long-random-string
```

When both are set the whole dashboard requires that login (HTTP Basic Auth over
HTTPS). Leave them blank only while testing locally.

---

## 6. GitHub, updates & backups

- **Push to GitHub** (you mentioned keeping projects there alongside Erica's): the
  `server/.gitignore` already excludes `node_modules`, `.env`, and your live
  `store.json`, so your key and data never get committed.
  ```bash
  git init && git add . && git commit -m "Conway Sales HQ"
  git branch -M main && git remote add origin git@github.com:YOU/tommyconway.git
  git push -u origin main
  ```
  To update the droplet later: `git pull` in `/var/www/tommyconway`, then
  `systemctl restart conway-hq` (and `systemctl reload caddy` if you changed the
  Caddyfile).
- **Back up the data**: everything Tom enters is in `server/data/store.json`.
  Copy it somewhere safe periodically:
  ```bash
  cp server/data/store.json ~/conway-backup-$(date +%F).json
  ```
- **Add Tom's real photo**: replace `landing/tom.jpg` (and `server/public/tom.jpg`
  for the dashboard avatar) with any square image of the same name.

---

## 7. What's inside

```
tommyconway-site/
├─ landing/            # public page → tommyconway.net
│  ├─ index.html
│  └─ tom.jpg
├─ server/            # admin app → admin.tommyconway.net
│  ├─ server.js        # Express: SPA + REST + AI proxy + news fetch
│  ├─ public/index.html# the whole dashboard (single-file SPA)
│  ├─ data/seed.json   # starter data (copied to store.json on first run)
│  ├─ .env.example
│  └─ package.json
├─ deploy/
│  ├─ Caddyfile        # web server + auto-HTTPS for both domains
│  └─ conway-hq.service# keeps the app running
└─ README.md
```

### Growing it later
When JSON gets limiting (multi-device, bigger data, multiple users), the data
layer is isolated in `server.js` behind a small REST API — swapping
`store.json` for Postgres or SQLite is a contained change. The news feeds are
editable in **Settings → News feeds** (RSS/Atom URLs or Google News queries).
