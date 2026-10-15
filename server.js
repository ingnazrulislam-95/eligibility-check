"use strict";
/**
 * Backend for the Czech study eligibility checker.
 * - Zero npm dependencies. Needs Node.js 22.13 or newer (uses the built-in node:sqlite).
 * - Serves the frontend from ./public and a small JSON API under /api.
 * - Stores rules, universities and the association page in SQLite, plus anonymous assessment counts.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

/* ---------- Config (from environment / .env) ---------- */
const PORT = +process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "app.db");
const PUBLIC_DIR = path.join(__dirname, "public");
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.TOKEN_SECRET) console.warn("TOKEN_SECRET is not set: admin sessions end whenever the server restarts.");

/* ---------- Database ---------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS admin (id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
    level TEXT NOT NULL, status TEXT NOT NULL, lang TEXT NOT NULL, country TEXT, sfield TEXT);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL);
`);
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, "defaults.json"), "utf8"));
const getRules = () => { const r = db.prepare("SELECT v FROM kv WHERE k='rules'").get(); return r ? JSON.parse(r.v) : null; };
const setRules = (obj) => db.prepare("INSERT INTO kv (k,v) VALUES ('rules',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(obj));
if (!getRules()) setRules(DEFAULTS);
const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");
const logAudit = (who, action) => db.prepare("INSERT INTO audit (at,who,action) VALUES (?,?,?)").run(now(), who, action);

/* ---------- Passwords and tokens ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function upsertAdminFromEnv() {
  const id = (process.env.ADMIN_ID || "").trim(), pw = process.env.ADMIN_PASSWORD || "";
  if (!id || !pw) {
    if (!db.prepare("SELECT 1 FROM admin LIMIT 1").get()) console.warn("No admin exists. Set ADMIN_ID and ADMIN_PASSWORD, then restart.");
    return;
  }
  if (pw.length < 10) { console.error("ADMIN_PASSWORD must be at least 10 characters."); process.exit(1); }
  const salt = crypto.randomBytes(16).toString("hex");
  db.exec("DELETE FROM admin");
  db.prepare("INSERT INTO admin (id,salt,hash) VALUES (?,?,?)").run(id, salt, hashPw(pw, salt));
}
upsertAdminFromEnv();

const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (p) => { const body = b64(JSON.stringify(p)); return body + "." + crypto.createHmac("sha256", SECRET).update(body).digest("base64url"); };
function verify(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const good = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (!safeEq(sig, good)) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}

/* ---------- Rate limiting (in memory) ---------- */
const hits = new Map();
function limited(key, max, windowMs) {
  const t = Date.now(); let h = hits.get(key);
  if (!h || h.reset < t) { h = { n: 0, reset: t + windowMs }; hits.set(key, h); }
  h.n++; return h.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (h.reset < t) hits.delete(k); }, 60000).unref();
const clientIp = (req) => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";

/* ---------- Validation ---------- */
const LEVELS = ["bachelor", "master", "phd"], STATUSES = ["likely", "pot", "miss", "info"];
const str = (v, max) => String(v ?? "").slice(0, max);
const num = (v, lo, hi) => { const n = +v; if (!Number.isFinite(n) || n < lo || n > hi) throw new Error("Number out of range"); return n; };
const isUrl = (u) => /^https?:\/\/[^\s]+$/i.test(u);

function cleanRules(r) {
  if (!r || typeof r !== "object") throw new Error("Invalid data");
  const levels = {};
  for (const k of LEVELS) {
    const L = r.levels && r.levels[k]; if (!L) throw new Error("Missing level " + k);
    levels[k] = { label: str(L.label, 40), qual: str(L.qual, 20), minPct: num(L.minPct, 0, 100), ielts: num(L.ielts, 0, 9), toefl: num(L.toefl, 0, 120), entrance: !!L.entrance };
  }
  if (!Array.isArray(r.unis) || r.unis.length > 300) throw new Error("Universities must be a list of up to 300");
  const unis = r.unis.map((u) => {
    if (!u || !str(u.name, 200).trim()) throw new Error("Each university needs a name");
    if (!isUrl(String(u.url || ""))) throw new Error("Invalid website for " + str(u.name, 60));
    const o = { name: str(u.name, 200), url: str(u.url, 300), levels: (Array.isArray(u.levels) ? u.levels : []).filter((x) => LEVELS.includes(x)), published: !!u.published, verified: !!u.verified, lastVerified: str(u.lastVerified, 20), editor: str(u.editor, 80) };
    if (u.cz) o.cz = str(u.cz, 200);
    if (Array.isArray(u.fields) && u.fields.length) o.fields = u.fields.map((f) => str(f, 30)).slice(0, 20);
    return o;
  });
  const A = r.assoc || {};
  const assoc = { name: str(A.name, 200), about: str(A.about, 5000), mission: str(A.mission, 5000), join: str(A.join, 5000), email: str(A.email, 200), website: str(A.website, 300), facebook: str(A.facebook, 300) };
  return { levels, unis, assoc };
}

/* ---------- HTTP helpers ---------- */
function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(code, Object.assign({ "Content-Type": type, "Cache-Control": "no-store" }, extra));
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const json = (res, code, obj) => send(res, code, obj);
function readJson(req, max = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error("Request too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { reject(Object.assign(new Error("Invalid JSON"), { code: 400 })); } });
    req.on("error", reject);
  });
}
function adminOf(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const p = m && verify(m[1]); return p ? p.sub : null;
}
const csvCell = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };

/* ---------- API ---------- */
async function api(req, res, url) {
  const ip = clientIp(req), p = url.pathname, m = req.method;

  if (p === "/api/health" && m === "GET") return json(res, 200, { ok: true });

  if (p === "/api/rules" && m === "GET") {
    const r = getRules(); return json(res, 200, { levels: r.levels, unis: r.unis.filter((u) => u.published), assoc: r.assoc });
  }

  if (p === "/api/assessments" && m === "POST") {
    if (limited("a:" + ip, 30, 60000)) return json(res, 429, { error: "Too many requests" });
    const b = await readJson(req);
    if (!LEVELS.includes(b.level) || !STATUSES.includes(b.status) || !["en", "cs"].includes(b.lang)) return json(res, 400, { error: "Invalid data" });
    db.prepare("INSERT INTO assessments (at,level,status,lang,country,sfield) VALUES (?,?,?,?,?,?)").run(now(), b.level, b.status, b.lang, str(b.country, 60), str(b.sfield, 30));
    return send(res, 204, "");
  }

  if (p === "/api/admin/login" && m === "POST") {
    if (limited("l:" + ip, 10, 15 * 60000)) return json(res, 429, { error: "Too many attempts" });
    const b = await readJson(req);
    const a = db.prepare("SELECT * FROM admin WHERE id=?").get(str(b.id, 100));
    const ok = a && safeEq(hashPw(String(b.password || ""), a.salt), a.hash);
    if (!ok) { logAudit("unknown", "failed login for id " + str(b.id, 40).replace(/[^\w.@-]/g, "?")); return json(res, 401, { error: "Wrong ID or password" }); }
    return json(res, 200, { token: sign({ sub: a.id, exp: Date.now() + 8 * 3600 * 1000 }) });
  }

  if (p.startsWith("/api/admin/")) {
    const who = adminOf(req); if (!who) return json(res, 401, { error: "Not signed in" });

    if (p === "/api/admin/rules" && m === "GET") return json(res, 200, getRules());
    if (p === "/api/admin/rules" && m === "PUT") {
      let clean; try { clean = cleanRules(await readJson(req)); } catch (e) { if (e.code) throw e; return json(res, 400, { error: e.message }); }
      setRules(clean); logAudit(who, "rules, universities and association page updated"); return json(res, 200, { ok: true });
    }
    if (p === "/api/admin/stats" && m === "GET") {
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])), byLevel = Object.fromEntries(LEVELS.map((s) => [s, 0]));
      for (const r of db.prepare("SELECT status, COUNT(*) n FROM assessments GROUP BY status").all()) byStatus[r.status] = r.n;
      for (const r of db.prepare("SELECT level, COUNT(*) n FROM assessments GROUP BY level").all()) byLevel[r.level] = r.n;
      return json(res, 200, { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus, byLevel });
    }
    if (p === "/api/admin/audit" && m === "GET") return json(res, 200, db.prepare("SELECT at, who, action FROM audit ORDER BY id DESC LIMIT 50").all());
    if (p === "/api/admin/export.csv" && m === "GET") {
      const lab = { likely: "Likely eligible", pot: "Eligible (items to verify)", miss: "Additional requirements not met", info: "Insufficient information" };
      const L = getRules().levels;
      const rows = db.prepare("SELECT * FROM assessments ORDER BY id").all().map((r) => [r.at, (L[r.level] || {}).label || r.level, lab[r.status] || r.status, r.lang === "cs" ? "Czech" : "English", r.country, r.sfield].map(csvCell).join(","));
      const csv = "\ufeff" + ["Date and time,Level,Result,Study language,Country of education,Field"].concat(rows).join("\r\n");
      return send(res, 200, csv, "text/csv; charset=utf-8", { "Content-Disposition": 'attachment; filename="eligibility-assessments.csv"' });
    }
  }
  return json(res, 404, { error: "Not found" });
}

/* ---------- Static files ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };
function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");
  let rel; try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, "Bad request", "text/plain"); }
  const file = path.join(PUBLIC_DIR, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "Not found", "text/plain");
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" });
  res.end(req.method === "HEAD" ? undefined : fs.readFileSync(file));
}

/* ---------- Server ---------- */
const SECURITY = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      if (CORS_ORIGIN) {
        res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN); res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
        if (req.method === "OPTIONS") return send(res, 204, "");
      }
      return await api(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    if (e && e.code === 413) return json(res, 413, { error: "Request too large" });
    if (e && e.code === 400) return json(res, 400, { error: e.message });
    console.error(e); return json(res, 500, { error: "Server error" });
  }
});
server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
