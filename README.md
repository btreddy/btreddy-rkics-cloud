# RkICS Supervisor Tracker — Cloud Version (Vercel + Supabase)

Same features as before (check-in/out with geofence, DPR text + voice,
site coverage alerts, dashboard with Excel export, working-hours chart) —
but hosted properly instead of depending on one office PC staying on.

**Why this fixes your two real problems:**
- **No more file-sync issues** — code lives in GitHub. Updating it is
  `git push`, not copying zips between PCs and hoping it landed right.
- **No more "can this PC stay on 24/7"** — Vercel hosts it, always on,
  not tied to any machine your team needs for actual work.

---

## What you're setting up (all free tiers, all under your control)

1. **GitHub** — holds the code (you already have this)
2. **Supabase** — free Postgres database (holds all your data — sites,
   supervisors, check-ins, DPRs, even the voice audio itself)
3. **Vercel** — free hosting that runs the app and serves the dashboard

---

## Step 1 — Supabase (the database)

1. Go to **supabase.com** → sign in → **New Project**
2. Pick a name (e.g. `rkics-tracker`), set a database password (**save
   this somewhere** — you'll need it in a moment), pick the region
   closest to you (Mumbai/Singapore for lowest latency from India)
3. Once it's created, go to the **SQL Editor** (left sidebar) → **New
   query** → paste the entire contents of `sql/schema.sql` from this
   project → **Run**. You should see "Success. No rows returned."
4. Go to **Project Settings → Database → Connection string** → select
   the **"Transaction" pooler** tab (important — this one handles many
   short-lived connections well, which is exactly what Vercel creates)
5. Copy that connection string — it looks like:
   `postgresql://postgres.xxxxx:[YOUR-PASSWORD]@aws-0-region.pooler.supabase.com:6543/postgres`
   Replace `[YOUR-PASSWORD]` with the database password from step 2.
   **This is your `DATABASE_URL`** — keep it handy for Step 3.

---

## Step 2 — Push this code to GitHub

```bash
cd rkics-cloud
git init
git add .
git commit -m "RkICS tracker - cloud version"
```
Create a new repository on GitHub (github.com → New repository → don't
initialize with a README, keep it empty), then:
```bash
git remote add origin https://github.com/<your-username>/rkics-cloud.git
git branch -M main
git push -u origin main
```

---

## Step 3 — Vercel (hosting)

1. Go to **vercel.com** → sign in **with your GitHub account** (this
   makes connecting the repo automatic)
2. **Add New → Project** → select your `rkics-cloud` repo → **Import**
3. Before deploying, expand **Environment Variables** and add these
   (from your `.env.example`, with real values):
   - `DATABASE_URL` — from Step 1
   - `TELEGRAM_BOT_TOKEN` — your existing bot token
   - `TELEGRAM_DIGEST_CHAT_IDS` — your existing chat IDs
   - `DASHBOARD_USER` / `DASHBOARD_PASS` — pick your own login
4. Click **Deploy**. Takes about a minute.
5. Once done, you'll get a URL like `https://rkics-cloud.vercel.app`

---

## Step 4 — Point Telegram at your new bot backend

Your bot now needs to run in **webhook mode** instead of the old
"polling" mode (this is what makes it work on serverless hosting).
One-time command — replace both placeholders and run once in any
terminal with internet access:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<your-app>.vercel.app/webhook/telegram"
```
You should get back `{"ok":true,"result":true,...}`.

Test it: message your bot `/start` on Telegram — should reply instantly.

---

## Step 5 — Precise daily digest timing (GitHub Actions, free)

Vercel's free-tier cron only guarantees your job runs *sometime within
the scheduled hour*, not the exact minute — not great for "the digest
goes out at 8:30 PM." Instead, this project includes a GitHub Actions
workflow that triggers it at the exact minute, for free:

1. In your GitHub repo → **Settings → Secrets and variables → Actions**
   → **New repository secret**
2. Name: `DIGEST_URL`, Value: `https://<your-app>.vercel.app/api/digest`
3. Done — `.github/workflows/digest.yml` is already set to run daily at
   15:00 UTC (8:30 PM IST). Edit the `cron:` line in that file if you
   want a different time (format: `minute hour * * *`, in UTC — IST is
   UTC+5:30).

Test it immediately without waiting: GitHub repo → **Actions** tab →
"Daily RkICS Digest" → **Run workflow**.

---

## Step 6 — Add your real sites and supervisors

From your own laptop (or anywhere with internet — no need for a
specific PC anymore):
```bash
npm install
cp .env.example .env   # fill in DATABASE_URL
node setup.js add-site "Office" 17.432911 78.333548 300
node setup.js add-supervisor "Ravi Kumar" telegram 987654321
node setup.js assign "Ravi Kumar" "Office"
node setup.js list
```
Same commands as before — just runs from wherever you are now.

---

## Step 7 — Dashboard

`https://<your-app>.vercel.app/dashboard` — same login you set in Step 3.

---

## Voice transcription

Also runs from anywhere now — your laptop, whenever convenient, not
tied to any specific machine:
```bash
pip install openai-whisper
node transcribe.js
```
It pulls pending voice notes from Supabase, transcribes locally on
your machine (nothing sent to a third party), and writes the text back.
Run it manually whenever, or set up a Windows Task Scheduler / cron job
to run it every hour or so if you want it automatic.

---

## What's different from the old local version

- Voice audio is stored **in the database itself** (as a blob), not as
  local files — so it's never tied to any one machine's disk.
- The bot no longer "polls" Telegram continuously — Telegram pushes
  messages to it via webhook instead. Functionally identical to you and
  supervisors, just architected for serverless hosting.
- Multi-step flows (pick a site → then share location) are tracked in
  the database (`pending_actions` table) instead of in server memory —
  necessary since serverless functions don't keep memory between
  requests the way the old always-on process did.
