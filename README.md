# Morning Reflection — Setup Guide

A voice-based morning check-in app for research study participants. Participants record short audio responses to guided questions each morning and optionally complete an evening mood check-in.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A [Supabase](https://supabase.com) project (free tier works)
- A [Google AI Studio](https://aistudio.google.com) API key with access to Gemini

---

## 1. Clone and install

```bash
git clone <repo-url>
cd INFO-4400-5400-LLM-Design
npm install
```

---

## 2. Environment variables

Create a `.env` file in the project root (never commit this file):

```
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:5432/postgres
GOOGLE_API_KEY=AIzaSy...
GOOGLE_CHAT_MODEL=gemini-2.0-flash
PORT=3000
```

### Getting each value

**`DATABASE_URL`**
1. Go to your Supabase project → **Project Settings** → **Database**
2. Under **Connection string**, select **Session mode** (port 5432)
3. Copy the full URL and replace `[YOUR-PASSWORD]` with your database password

> Use the pooler URL (`aws-0-*.pooler.supabase.com`) — the direct `db.*.supabase.co` hostname can fail DNS resolution.

**`GROQ_API_KEY`**
1. Go to [console.groq.com](https://console.groq.com) → **API Keys** → **Create API Key**
2. Copy the key — it starts with `gsk_`

**`PORT`** — optional, defaults to `3000`

---

## 3. Run the app

```bash
npm start
```

The server will:
- Connect to the database and create all tables automatically on first run
- Start at `http://localhost:3000`

---

## App flow

### Morning reflection
- Open daily **7:00 AM – 12:00 PM**
- Outside that window, the home screen shows a locked state ("See you tomorrow")
- The session ends automatically after **10 questions** or **10 minutes**, whichever comes first
- Manually ending early via "Conclude reflection" also counts as complete

### Evening reflection
- Available from **9:00 PM** the same day until **7:00 AM** the following morning
- Only unlocked if the participant completed their morning reflection that day

### Participant IDs
- Participants either enter an existing ID or generate a new one (`P-XXXX`)
- The ID is also the password — no separate credential needed
- Day number is tracked server-side; participants can use any device

---

## Dev mode

Append `?dev=1` to the URL to enable the developer side panel.

**Local:**
```
http://localhost:3000/?dev=1
```

**GitHub Codespaces:**

Codespaces forwards the port to a URL like:
```
https://<codespace-name>-3000.app.github.dev/
```
To find yours:
1. In VS Code, open the **Ports** tab (bottom panel)
2. Find port `3000` and click the globe icon to open it in the browser
3. Append `?dev=1` to that URL:
```
https://<codespace-name>-3000.app.github.dev/?dev=1
```

> If the Ports tab shows port 3000 as private, right-click it and set visibility to **Public** so the browser can load it without authentication errors.

A **DEV** tab appears on the right edge of the screen. Click it to open the panel.

### Mock Date & Time

Override the current date and/or time to test time-gated behaviour without waiting:

| Time set | Effect |
|---|---|
| 7:00 AM – 12:00 PM | Morning home — Record button active |
| Before 7:00 AM or after 12:00 PM | Morning home — Locked ("See you tomorrow") |
| 9:00 PM – 7:00 AM | Morning home — Evening button unlocked |
| Outside that window | Morning home — Evening button shows opening time |

Click **↺** next to either field to reset it back to the real clock.

### Morning completion toggle

Toggles `morningCompleted` between done and not done without going through the full chat flow.

- **Morning: not done** — home screen locks after noon; evening emoji shows a locked state
- **Morning: done ✓** — evening flow is accessible (subject to the time window above)

### Jump to screen

Instantly navigate to any screen in the app:

| Button | Notes |
|---|---|
| Welcome | Login / register screen |
| Home | Morning recording home |
| Chat | Auto-creates a dev session if none exists |
| Morning Done | Completion confirmation screen |
| Morning Home | Sets morning session date to now; respects morning toggle for evening button |
| Evening Emoji | Shows locked or active state based on morning toggle |
| Ev. Slider | Intensity slider |
| Ev. Text | Optional reflection text |
| Ev. Complete | Final evening screen |

---

## Project structure

```
├── server.js          # HTTP server, API routes, Gemini integration
├── db.js              # PostgreSQL connection and schema setup
├── public/
│   ├── index.html     # Single-page app, all 10 screens
│   ├── app.js         # Frontend logic and state
│   └── styles.css     # All styles including dev panel
├── data/
│   └── audio/         # Saved audio recordings (created automatically)
├── .env               # Environment variables (do not commit)
└── .env.example       # Template for required variables
```

## Database tables

| Table | Purpose |
|---|---|
| `users` | Participant accounts |
| `sessions` | One row per daily morning session |
| `turns` | Each recorded response within a session, including audio |
| `evening_checkins` | Evening mood, intensity, and optional reflection |
| `events` | Audit log of key app events |
