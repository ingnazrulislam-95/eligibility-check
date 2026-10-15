# Czech Study Eligibility Checker (for Bangladeshi students)

A free checker that gives a preliminary eligibility result for Bachelor's, Master's and PhD study in Czechia.
It is not an admission or visa decision, and the sample university data is **demo data, not verified**.

## What is inside

| Path | What it is |
|---|---|
| `public/index.html` | The whole frontend: landing page, questionnaire, results, Association tab, admin panel. |
| `public/config.js` | One line: `window.CZ_API_BASE`. Leave empty when `server.js` serves the page. |
| `server.js` | Backend (Node.js, no npm packages): API, admin login, SQLite storage, CSV export, static file server. |
| `defaults.json` | Starting rules, universities and Association page. Loaded once into the database. |
| `.env.example` | Settings to copy to `.env`. |
| `Dockerfile`, `.github/workflows/pages.yml` | Optional deployment helpers. |

## Run on your computer

1. Install **Node.js 22.13 or newer** (https://nodejs.org). Check with `node -v`.
2. Copy `.env.example` to `.env`. Set `ADMIN_ID`, a `ADMIN_PASSWORD` of at least 10 characters, and `TOKEN_SECRET`
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
3. Run `npm start`, then open http://localhost:3000. Admin is the "Admin (demo)" link in the footer.

There is nothing to install. The database file is created at `data/app.db` on first start.

## Deploy

**A. Frontend only on GitHub Pages (free, no server).** Push this folder to GitHub, set Settings > Pages > Source to
"GitHub Actions". The page works in browser-only mode: the admin lock, edits and statistics stay in each visitor's own browser,
so you cannot see how many people use it overall.

**B. Full app (recommended).** Use any host that runs Node.js 22 (Render, Railway, Fly.io, a VPS) or the Dockerfile.
- Start command: `npm start`. Set the environment variables from `.env.example` in the host's dashboard (not in GitHub).
- Add a persistent disk or volume mounted at `data/`, otherwise the database is lost on each redeploy.
- Set `TRUST_PROXY=1` when the host sits behind a proxy.
- Point your domain at the host (the host explains the DNS records). HTTPS is required for the admin login.

**C. Frontend and backend on different domains.** Host `public/` on GitHub Pages and the backend elsewhere.
In `public/config.js` set `window.CZ_API_BASE = "https://your-backend-domain";` and on the server set
`CORS_ORIGIN=https://your-frontend-domain`.

## Maintain and customize

- **Without code:** log in to Admin to edit minimum results, IELTS/TOEFL, universities and the Association page. Changes apply to all visitors immediately and are written to the audit log.
- **Rules in code:** the checks (GAP test, Nostrification, MOI, Bangladesh 3-year rule, final-year message) are in the `assess()` function in `public/index.html`. The 4-step guide is the `GUIDE` list in the same file.
- **Add a question:** add a field to `STEPS` and use it in `assess()`.
- **Statistics:** Admin shows counts and downloads a CSV (opens in Excel). Only level, result, language, country of education and field are stored. No names, contact details or passport data.
- **Back up** `data/app.db` regularly.

## Security notes

- The admin password is never in the code. Only a salted scrypt hash is stored. Sessions last 8 hours. Login and public submissions are rate limited.
- Never commit `.env`. Use a strong `ADMIN_PASSWORD`.
- Rate limits and sessions are kept in memory, so they reset when the server restarts (set `TOKEN_SECRET` to keep sessions).

## Not included yet

Student accounts and assessment history, Google sign-in, multiple admin users with roles, and per-university eligibility rules.
Verify every university's requirements, fees and deadlines on its official website before publishing them as facts.
