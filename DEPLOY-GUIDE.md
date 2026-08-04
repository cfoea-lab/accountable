# Getting Accountable onto your phones — step by step

This guide assumes no deployment experience. There are two parts:

- **Part 1 (2 minutes):** use it from your iPhone *right now*, on your home/office wifi.
- **Part 2 (~20 minutes, free):** put it on the internet so you and Logan can both use it from anywhere, and install it to your Home Screens like a real app.

---

## Part 1 — Use it on your iPhone right now (same wifi)

Your app is already running on your computer. Any phone on the same wifi can open it.

1. On the computer running the app, find its network address. On a Mac, open **Terminal** and run:
   ```
   ipconfig getifaddr en0
   ```
   You'll get something like `192.168.1.23`.
2. On your iPhone (same wifi network), open Safari and go to:
   `http://192.168.1.23:3000` (using your number from step 1).
3. Tap the **Share** button → **Add to Home Screen** → **Add**. You now have an Accountable icon that opens full-screen.

Limits of Part 1: it only works while your computer is on and only on the same wifi. Part 2 removes both limits.

---

## Part 2 — Put it online, free (recommended: Render + Turso)

**Why this setup:** hosting a Node app for free is possible on Render, but Render's free tier deletes any files the app saves whenever it restarts. That's why the app stores all data — including photos — in a free hosted database (Turso) instead. Result: $0/month, both of you use the same URL from anywhere, data is never lost. The one trade-off: after 15 minutes with no visitors the app naps, and the first open takes about a minute to wake up.

(If you'd rather pay ~$5/month for an always-on app with no nap, Railway is simpler: create a project from the same GitHub repo, add a volume, done. Everything below assumes the free route.)

You'll create three free accounts. Use the same email for all of them to keep life simple.

### Step 1 — Put the code on GitHub (the code library site)

1. Go to **github.com** and sign in (or Sign up — it's free).
2. Click the **+** in the top-right → **New repository**.
3. Name it `accountable`, leave it **Public**, click **Create repository**.
   *(Public is fine — the code contains no passwords or personal data. Your database credentials will live only in Render's settings.)*
4. On the new repo page, click the link **"uploading an existing file"**.
5. On your computer, open the unzipped `accountable` folder. Select **everything inside it** (server.js, db.js, package.json, README.md, seed-demo.js, and the `public` folder) and **drag them all into the GitHub upload box** in your browser. Wait for the `public` folder's files to appear in the list too.
6. Click **Commit changes**. Your code is now at `https://github.com/YOUR-USERNAME/accountable`.

> Already have the repo? If a repo named `accountable` already exists from an earlier session, just do steps 4–6 on that repo.

### Step 2 — Create the free database (Turso)

1. Go to **turso.tech** → **Sign up** (you can sign up with your GitHub account in one click).
2. In the dashboard, click **Create Database**. Name it `accountable`. Pick the region closest to you (for the Philippines, choose a Singapore/Asia region if offered).
3. Open the database's page. You need two things — copy each into a note:
   - **URL** — looks like `libsql://accountable-yourname.turso.io`
   - **Token** — click **Create Token** (or "Generate token"), copy the long text that appears.

### Step 3 — Deploy on Render (the hosting)

1. Go to **render.com** → **Sign up** (again, "Sign up with GitHub" is easiest).
2. Click **New +** → **Web Service**.
3. Choose **Public Git Repository** and paste your repo address:
   `https://github.com/YOUR-USERNAME/accountable`
4. Fill the form:
   - **Name:** `accountable` (this becomes your URL)
   - **Language/Runtime:** Node
   - **Build command:** leave empty (or `echo none`)
   - **Start command:** `node server.js`
   - **Instance type:** **Free**
5. Scroll to **Environment Variables** and add two:
   - Key `TURSO_URL` → value: the URL from Step 2
   - Key `TURSO_TOKEN` → value: the token from Step 2
6. Click **Deploy Web Service**. Watch the log; after a minute or two it should say the service is live. Your app is now at:
   `https://accountable-XXXX.onrender.com` (Render shows the exact URL at the top).
7. Open that URL. You should see the app. Log a test meal to confirm saving works.

### Step 4 — Install it on both phones

Send the URL to Logan, then on each phone:

- **iPhone:** open the URL in **Safari** → Share button → **Add to Home Screen** → Add.
- **Android:** open the URL in **Chrome** → you'll get an **Install app** prompt (or menu ⋮ → *Add to Home screen*).

Because the app is a Progressive Web App served over HTTPS, the installed icon opens full-screen like a native app, and it will even show your last-loaded data when you're briefly offline.

### If something goes wrong

- **Render log says "Storage init failed":** the `TURSO_URL` or `TURSO_TOKEN` value is wrong — re-copy them from Turso (the URL must start with `libsql://` or `https://`), save, and click **Manual Deploy → Deploy latest commit**.
- **The page takes a minute to load:** that's the free tier waking up. Normal.
- **You changed the code:** upload the changed files to GitHub the same drag-and-drop way, then in Render click **Manual Deploy**.

### What this costs and where your data lives

$0/month. Data (including photos) lives in your Turso database — free tier includes 5 GB, which at phone-photo sizes is years of meals. Turso keeps daily restore points. The Render service itself stores nothing, so its restarts can't lose anything.

---

## A note on running it locally after this

Nothing changed for local use: `node server.js` on your computer still works exactly as before and saves to a local file (`data/accountable.db`). The hosted database is only used when the two environment variables are set (i.e., on Render). One caveat: photos are now stored inside the database rather than as loose files, so photos logged with the *previous* copy of the app won't display in this version — if you'd already logged real photos, say so before switching.
