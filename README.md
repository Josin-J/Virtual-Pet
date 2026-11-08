# 👻 Pip: Your Shared Pocket Ghost & Desktop Companion

Pip is a friendly, stress-free virtual ghost companion you can care for from your phone, browser, or desktop. Several devices can join using a 8-character code to care for the same Pip in real time.

Zero external dependencies for the web server (uses Node's built-in `node:sqlite`). Includes an optional **Electron desktop companion** that lets Pip freely float and roam over your entire Windows desktop and other applications.

---

## 🚀 Quick Start

### 1. Web App (Phone & PC)
```bash
npm start
```
Open **http://localhost:3000** in your browser.

- To open on your phone, connect to the same Wi-Fi and open `http://<your-computer-LAN-IP>:3000`.
- Create a Pip on one device, then use **"Join with a code"** on your other devices.

### 2. Desktop Companion (Floats Over All Desktop Apps)
```bash
npm run desktop
```
Pip will immediately appear floating over your Windows desktop, staying on top of all applications even when browsers are minimized.

### 3. Run Tests
```bash
npm test                   # 26 automated unit & API tests
```

---

## 🎮 Desktop Companion Controls

| Action | Control | What Happens |
|---|---|---|
| **Summon Anywhere** | `Ctrl + Alt + P` | Pip flies across your screen straight to your mouse cursor! |
| **Pass-Through Clicks** | Click through empty space | Clicks pass through seamlessly to whatever background app you're using. |
| **Pat Pip** | Left-click Pip | Pip twirls with a happy spin and stardust particles. |
| **Acrobatic Somersault** | Double-click Pip | Pip does a 360° backflip with a burst of sparks. |
| **Throw with Inertia** | Drag & fling Pip | Drag Pip and release with momentum — he glides smoothly across the screen. |
| **Context Menu** | Right-click Pip | Opens a menu: `Pat`, `Poke`, `Boo!`, `Comfort`, `Say something`, `Reset position`. |
| **System Tray** | Right-click tray icon | Summon to mouse, reset position, or quit. |
| **Mindful Reminders** | Automatic | Pip occasionally shares gentle encouraging thoughts and reminders to drink water or rest your eyes. |

---

## ✨ In-Browser Floating & Animations

Click the **🚀 Float** button in the web interface to release Pip from his card:
- **Autonomous Organic Roaming**: Drifts across the screen following smooth curves with deceleration and idle stops.
- **Flight Tilting & Banking**: Tilts in the direction of flight (up to ±25°) based on velocity.
- **Black & White Ghost Particles**: Leaves behind a subtle monochrome stardust trail (`#ffffff`, `#111111`, and monochrome tones).
- **Squish & Stretch**: Compresses softly upon impacting screen edges and rebounds with spring physics.
- **Mood Reactions**: Somersaults and stardust bursts when happy, quick dashes when surprised, slow sinking drift when sad, and twitchy shakes when angry.
- **Session Memory**: Remembers whether Pip is floating or docked in `localStorage`.

---

## 🌐 How to Make Pip Available Online

You can make Pip accessible over the internet using any of these methods:

### Option A: Instant Free Public Link (Fastest — 30 seconds)
Share your local Pip server with friends or your phone anywhere in the world without deploying code or setting up port forwarding:

**Using Cloudflare Tunnel (Free, no account needed):**
```bash
# 1. Start your server in one terminal:
npm start

# 2. In another terminal, run:
npx cloudflared tunnel --url http://localhost:3000
```
Cloudflare will give you a public `https://xxxx.trycloudflare.com` URL that works worldwide over HTTPS!

*Or using ngrok:*
```bash
npx ngrok http 3000
```

---

### Option B: Free 24/7 Cloud Hosting (Render / Railway / Fly.io)

Pip uses SQLite, so it only requires a Node.js runtime and a persistent disk volume.

#### Deploying on Render (render.com):
1. Push your repository to GitHub.
2. In the Render Dashboard, click **New +** → **Web Service** and connect your repo.
3. Configure the service:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free or Starter
4. Add Environment Variables:
   - `PORT` = `3000` (or `10000`)
   - `TRUST_PROXY` = `1`
   - `DB_PATH` = `/var/data/pip.db`
5. Under **Disks** (Starter tier):
   - Mount a persistent disk at `/var/data` so your pet's SQLite database survives server restarts.

#### Deploying on Railway (railway.app):
1. Click **New Project** → **Deploy from GitHub repo**.
2. Add a **Volume** mounted to `/data`.
3. Add Environment Variables:
   - `DB_PATH` = `/data/pip.db`
   - `TRUST_PROXY` = `1`
   - `PORT` = `3000`

---

### Option C: Self-Hosted VPS (Ubuntu/Debian + Caddy or Nginx)

1. **Clone and install on your server:**
   ```bash
   git clone <your-repo> /opt/pip
   cd /opt/pip
   npm install --omit=dev
   ```

2. **Run as a systemd service (`/etc/systemd/system/pip.service`):**
   ```ini
   [Unit]
   Description=Pip Shared Pet Server
   After=network.target

   [Service]
   Type=simple
   User=www-data
   WorkingDirectory=/opt/pip
   Environment=PORT=3000
   Environment=HOST=127.0.0.1
   Environment=TRUST_PROXY=1
   Environment=DB_PATH=/var/lib/pip/pip.db
   ExecStart=/usr/bin/node server/index.js
   Restart=always

   [Install]
   WantedBy=multi-user.target
   ```

3. **Reverse Proxy with Caddy (automatic HTTPS):**
   ```caddyfile
   pip.yourdomain.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

---

## 📁 Project Structure

```
├── desktop/                  # Electron Desktop Companion
│   ├── main.js               # Transparent, borderless, always-on-top window & tray
│   ├── preload.js            # Secure IPC bridge
│   └── overlay.html          # Roaming Pip overlay with physics & context menu
├── public/                   # Responsive Web Application
│   ├── index.html            # Single-page UI
│   ├── app.js                # Client logic, SSE sync, optimistic updates & floating
│   ├── pip.js                # Pure inline SVG renderer (silhouette, moods, headphones)
│   ├── style.css             # Fluid layout, animations, monochrome particles
│   └── icon.svg              # App icon
├── server/                   # Server Runtime
│   ├── index.js              # HTTP API router, SSE live streams, rate limiting
│   └── db.js                 # SQLite schema, transactions, migrations
├── shared/                   # Shared Logic
│   └── reducer.js            # Pure pet state reducer (shared by server & optimistic UI)
├── test/                     # Test Suite
│   ├── api.test.js           # Full API integration tests
│   └── reducer.test.js       # Pure state reducer tests
└── package.json              # Scripts & devDependencies (Electron)
```

---

## 🔒 Security & Sync Architecture

- **Sync**: Every action has a client-generated UUID for idempotent replay. Concurrent actions converge gracefully.
- **Offline First**: Actions taken while offline are queued in `localStorage` and automatically replay upon reconnection.
- **Security**: 256-bit device tokens (only SHA-256 stored in DB), IP rate limiting, strict Content Security Policy (CSP), zero inline scripts, and all user text rendered safely via `textContent`.
