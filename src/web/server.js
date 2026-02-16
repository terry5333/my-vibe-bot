"use strict";

/**
 * src/web/server.js
 * 中文後台（側邊選單、搜尋玩家、加減分按鈕、排行榜、中文設定表單）
 */

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");

/* -------------------- Firebase DB 取得（如果你已有 db/firebase.js 可改用那份） -------------------- */
let _db = null;

function getDb() {
  if (_db) return _db;

  if (!admin.apps.length) {
    const rawUrl =
      process.env.FIREBASE_DB_URL ||
      process.env.FIREBASE_DATABASE_URL ||
      process.env.DATABASE_URL;

    if (!rawUrl) {
      throw new Error("❌ 缺少 FIREBASE_DB_URL（Realtime Database 的網址）");
    }

    // 只留 origin（避免你貼到 console 的網址或帶 /data 之類）
    const url = new URL(rawUrl).origin;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        databaseURL: url,
      });
    } else {
      // 如果你的平台不是 GCP 可能會需要上面的 service account
      admin.initializeApp({ databaseURL: url });
    }
  }

  _db = admin.database();
  return _db;
}

/* -------------------- Express -------------------- */
const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* -------------------- ENV -------------------- */
const { JWT_SECRET, ADMIN_USER, ADMIN_PASS } = process.env;

if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.error("❌ 缺少 ENV：JWT_SECRET / ADMIN_USER / ADMIN_PASS");
}

/* -------------------- Runtime（讓 web 拿到 discord client） -------------------- */
const runtime = {
  app,
  client: null,
};

function attachRuntime(webRuntime, { client }) {
  // 你在 index.js 裡呼叫 attachRuntime(startWeb(), { client })
  if (webRuntime && typeof webRuntime === "object") {
    webRuntime.client = client;
  }
  runtime.client = client;
  return webRuntime;
}

/* -------------------- Helpers -------------------- */
function isHttps(req) {
  return !!(req.secure || req.headers["x-forwarded-proto"] === "https");
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authPage(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.redirect("/admin/login");
  try {
    verifyToken(token);
    return next();
  } catch {
    return res.redirect("/admin/login");
  }
}

function authApi(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ ok: false, error: "UNAUTH" });
  try {
    verifyToken(token);
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "UNAUTH" });
  }
}

function ok(res, data = {}) {
  return res.json({ ok: true, ...data });
}

function err(res, code, message) {
  return res.status(code).json({ ok: false, error: message || "ERROR" });
}

/* -------------------- DB 路徑（你如果想改成每個伺服器一份，就把 points 改成 points/{guildId}/{userId}） -------------------- */
function pointsRef(userId) {
  return getDb().ref(`points/${userId}`);
}

function settingsRef(guildId) {
  // guildId = "global" 時就是全域設定
  return getDb().ref(`settings/${guildId || "global"}`);
}

/* -------------------- 基本頁面 -------------------- */
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => ok(res, { status: "ok" }));

/* -------------------- 登入頁 -------------------- */
app.get("/admin/login", (req, res) => {
  const showErr = Boolean(req.query?.err);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(loginHtml(showErr));
});

app.post("/admin/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = signToken({ user });
    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: isHttps(req),
      sameSite: "lax",
      maxAge: 12 * 60 * 60 * 1000,
      path: "/",
    });
    return res.redirect("/admin");
  }
  return res.redirect("/admin/login?err=1");
});

app.get("/admin/logout", (req, res) => {
  res.clearCookie("admin_token", { path: "/" });
  res.redirect("/admin/login");
});

/* -------------------- 後台 UI -------------------- */
app.get("/admin", authPage, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(adminHtml());
});

/* =======================================================================
 *  API：伺服器清單（只列「伺服器」，不是成員）
 * ======================================================================= */
app.get("/admin/api/guilds", authApi, async (req, res) => {
  try {
    const client = runtime.client;
    if (!client) return ok(res, { guilds: [] });

    const guilds = client.guilds?.cache
      ? Array.from(client.guilds.cache.values()).map((g) => ({
          id: g.id,
          name: g.name,
          icon: g.iconURL?.({ size: 64 }) || null,
        }))
      : [];

    return ok(res, { guilds });
  } catch (e) {
    console.error("[Web] guilds error:", e);
    return err(res, 500, "GUILDS_FAILED");
  }
});

/* =======================================================================
 *  API：搜尋成員（不列出全員，只用 query 搜）
 *  GET /admin/api/member/search?guildId=xxx&q=abc
 * ======================================================================= */
app.get("/admin/api/member/search", authApi, async (req, res) => {
  try {
    const client = runtime.client;
    const guildId = String(req.query?.guildId || "");
    const q = String(req.query?.q || "").trim();

    if (!client) return ok(res, { members: [] });
    if (!guildId) return err(res, 400, "NEED_GUILD_ID");
    if (!q || q.length < 2) return ok(res, { members: [] });

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return err(res, 404, "GUILD_NOT_FOUND");

    // Discord API 搜尋（不會抓全員）
    const result = await guild.members.search({ query: q, limit: 10 }).catch(() => null);
    const members = result
      ? Array.from(result.values()).map((m) => ({
          id: m.user.id,
          name: m.user.globalName || m.user.username,
          username: m.user.username,
          avatar: m.user.displayAvatarURL({ size: 64 }),
        }))
      : [];

    return ok(res, { members });
  } catch (e) {
    console.error("[Web] member search error:", e);
    return err(res, 500, "MEMBER_SEARCH_FAILED");
  }
});

/* =======================================================================
 *  API：讀取某人分數
 *  GET /admin/api/points/get?userId=xxx
 * ======================================================================= */
app.get("/admin/api/points/get", authApi, async (req, res) => {
  try {
    const userId = String(req.query?.userId || "");
    if (!userId) return err(res, 400, "BAD_REQUEST");

    const snap = await pointsRef(userId).get();
    const points = Number(snap.val() ?? 0);
    return ok(res, { userId, points });
  } catch (e) {
    console.error("[Web] points get error:", e);
    return err(res, 500, "POINTS_GET_FAILED");
  }
});

/* =======================================================================
 *  API：加減分（transaction 防打架）
 *  POST /admin/api/points/adjust  { userId, delta }
 * ======================================================================= */
app.post("/admin/api/points/adjust", authApi, async (req, res) => {
  try {
    const { userId, delta } = req.body || {};
    const uid = String(userId || "").trim();
    const d = Number(delta);

    if (!uid || !Number.isFinite(d)) return err(res, 400, "BAD_REQUEST");

    const ref = pointsRef(uid);
    const result = await ref.transaction((cur) => {
      const curNum = Number(cur ?? 0);
      return curNum + d;
    });

    if (!result.committed) return err(res, 500, "TX_NOT_COMMITTED");

    const after = Number(result.snapshot.val() ?? 0);
    return ok(res, { userId: uid, after });
  } catch (e) {
    console.error("[Web] points adjust error:", e);
    return err(res, 500, "ADJUST_FAILED");
  }
});

/* =======================================================================
 *  API：排行榜（掃 points/ 取 top N）
 *  GET /admin/api/leaderboard?top=20
 * ======================================================================= */
app.get("/admin/api/leaderboard", authApi, async (req, res) => {
  try {
    const top = Math.max(1, Math.min(100, Number(req.query?.top || 20)));

    // Realtime DB 沒有很好用的「按 value 排序 + topN」，最簡單是全掃再排序（小量使用 OK）
    const snap = await getDb().ref("points").get();
    const obj = snap.val() || {};

    const rows = Object.entries(obj)
      .map(([userId, points]) => ({ userId, points: Number(points ?? 0) }))
      .sort((a, b) => b.points - a.points)
      .slice(0, top);

    return ok(res, { rows });
  } catch (e) {
    console.error("[Web] leaderboard error:", e);
    return err(res, 500, "LEADERBOARD_FAILED");
  }
});

/* =======================================================================
 *  API：解析使用者資訊（給排行榜用）
 *  POST /admin/api/users/resolve { ids: ["id1","id2"] }
 * ======================================================================= */
app.post("/admin/api/users/resolve", authApi, async (req, res) => {
  try {
    const client = runtime.client;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 30) : [];

    if (!client || !ids.length) return ok(res, { users: {} });

    const users = {};
    for (const id of ids) {
      const u = await client.users.fetch(id).catch(() => null);
      if (!u) continue;
      users[id] = {
        id: u.id,
        name: u.globalName || u.username,
        username: u.username,
        avatar: u.displayAvatarURL({ size: 64 }),
      };
    }

    return ok(res, { users });
  } catch (e) {
    console.error("[Web] users resolve error:", e);
    return err(res, 500, "USERS_RESOLVE_FAILED");
  }
});

/* =======================================================================
 *  API：設定（中文表單用）
 *  GET  /admin/api/settings?guildId=global
 *  POST /admin/api/settings?guildId=global
 * ======================================================================= */
app.get("/admin/api/settings", authApi, async (req, res) => {
  try {
    const guildId = String(req.query?.guildId || "global");
    const snap = await settingsRef(guildId).get();
    const settings = snap.val() || {};
    return ok(res, { settings });
  } catch (e) {
    console.error("[Web] settings get error:", e);
    return err(res, 500, "SETTINGS_FAILED");
  }
});

app.post("/admin/api/settings", authApi, async (req, res) => {
  try {
    const guildId = String(req.query?.guildId || "global");
    const payload = req.body || {};
    await settingsRef(guildId).set(payload);
    return ok(res, { saved: true });
  } catch (e) {
    console.error("[Web] settings save error:", e);
    return err(res, 500, "SETTINGS_SAVE_FAILED");
  }
});

/* -------------------- 404 -------------------- */
app.use((req, res) => res.status(404).send("Not Found"));

/* -------------------- Start -------------------- */
function startWeb() {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => console.log(`[Web] listening on ${PORT}`));
  return runtime;
}

module.exports = { startWeb, attachRuntime, app };

/* =======================================================================================
 *  HTML（中文後台）
 * ======================================================================================= */
function loginHtml(showErr) {
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>管理員登入</title>
<style>
  :root{--bg:#0b1220;--card:rgba(255,255,255,.06);--card2:rgba(255,255,255,.08);--text:#e5e7eb;--muted:#9ca3af;--pri:#38bdf8;--bad:#ef4444;}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 500px at 20% 10%, rgba(56,189,248,.25), transparent), var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC";}
  .box{width:min(420px,92vw);background:var(--card);border:1px solid rgba(255,255,255,.10);border-radius:18px;padding:22px;backdrop-filter:blur(10px)}
  h1{margin:0 0 10px;font-size:18px}
  .muted{color:var(--muted);font-size:12px;margin-bottom:14px}
  input,button{width:100%;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.05);color:var(--text);outline:none}
  input{margin:8px 0}
  button{margin-top:10px;background:linear-gradient(90deg, rgba(56,189,248,.9), rgba(99,102,241,.9));border:none;font-weight:700;cursor:pointer}
  .err{margin-top:12px;background:rgba(239,68,68,.16);border:1px solid rgba(239,68,68,.4);padding:10px;border-radius:12px;color:#fecaca}
</style>
</head>
<body>
  <form class="box" method="POST" action="/admin/login">
    <h1>機器人管理後台</h1>
    <div class="muted">請輸入管理員帳密</div>
    <input name="user" placeholder="帳號" required />
    <input name="pass" type="password" placeholder="密碼" required />
    <button type="submit">登入</button>
    ${showErr ? `<div class="err">帳號或密碼錯誤</div>` : ``}
  </form>
</body>
</html>`;
}

function adminHtml() {
  // 預設設定（表單會讀取 /admin/api/settings）
  const defaultSettings = {
    // 你可以把遊戲設定都放這裡，bot 端自己去讀 settings/global 或 settings/{guildId}
    gameEnabled: true,
    pointsEnabled: true,
    cooldownSec: 2,
  };

  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>中文管理後台</title>
<style>
  :root{
    --bg:#0b1220;
    --panel:rgba(255,255,255,.06);
    --panel2:rgba(255,255,255,.08);
    --border:rgba(255,255,255,.10);
    --text:#e5e7eb;
    --muted:#9ca3af;
    --pri:#38bdf8;
    --pri2:#6366f1;
    --bad:#ef4444;
    --ok:#22c55e;
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    background:radial-gradient(1200px 600px at 15% 0%, rgba(56,189,248,.18), transparent),
               radial-gradient(900px 500px at 90% 30%, rgba(99,102,241,.18), transparent),
               var(--bg);
    color:var(--text);
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC";
  }
  a{color:var(--pri)}
  .layout{display:grid;grid-template-columns:280px 1fr;min-height:100vh}
  .side{
    padding:18px;
    border-right:1px solid var(--border);
    background:rgba(0,0,0,.18);
    backdrop-filter:blur(10px);
  }
  .brand{
    display:flex;gap:10px;align-items:center;
    padding:12px 12px;
    border:1px solid var(--border);
    background:var(--panel);
    border-radius:16px;
  }
  .dot{
    width:14px;height:14px;border-radius:999px;
    background:linear-gradient(180deg,var(--pri),var(--pri2));
    box-shadow:0 0 22px rgba(56,189,248,.35);
  }
  .brand h1{font-size:14px;margin:0}
  .brand .muted{font-size:12px;color:var(--muted)}
  .nav{margin-top:14px;display:flex;flex-direction:column;gap:8px}
  .nav button{
    width:100%;
    text-align:left;
    padding:12px 12px;
    border-radius:14px;
    border:1px solid var(--border);
    background:rgba(255,255,255,.04);
    color:var(--text);
    cursor:pointer;
    font-weight:650;
  }
  .nav button.active{
    background:linear-gradient(90deg, rgba(56,189,248,.22), rgba(99,102,241,.18));
    border-color:rgba(56,189,248,.35);
  }
  .main{padding:18px 18px 50px}
  .topbar{
    display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between;
    padding:14px;
    border:1px solid var(--border);
    background:var(--panel);
    border-radius:18px;
  }
  .pill{
    display:flex;align-items:center;gap:10px;
    border:1px solid var(--border);
    background:rgba(255,255,255,.04);
    padding:10px 12px;
    border-radius:999px;
  }
  .pill img{width:28px;height:28px;border-radius:8px;object-fit:cover}
  select,input,textarea{
    border-radius:12px;
    border:1px solid var(--border);
    background:rgba(255,255,255,.05);
    color:var(--text);
    padding:10px 12px;
    outline:none;
  }
  textarea{width:100%;min-height:140px;resize:vertical}
  .btn{
    border:none;
    background:linear-gradient(90deg, rgba(56,189,248,.9), rgba(99,102,241,.9));
    color:#07101f;
    font-weight:800;
    padding:10px 12px;
    border-radius:12px;
    cursor:pointer;
  }
  .btn.ghost{
    background:rgba(255,255,255,.06);
    color:var(--text);
    border:1px solid var(--border);
    font-weight:700;
  }
  .grid{margin-top:14px;display:grid;grid-template-columns:1fr;gap:12px}
  .card{
    border:1px solid var(--border);
    background:var(--panel);
    border-radius:18px;
    padding:14px;
  }
  .card h2{margin:0 0 10px;font-size:16px}
  .muted{color:var(--muted);font-size:12px}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  table{width:100%;border-collapse:collapse}
  th,td{border-bottom:1px solid rgba(255,255,255,.10);padding:10px;text-align:left;vertical-align:middle}
  th{color:#cbd5e1;font-size:12px}
  .u{display:flex;gap:10px;align-items:center}
  .u img{width:34px;height:34px;border-radius:12px;object-fit:cover;background:rgba(255,255,255,.06)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono";font-size:12px}
  .tag{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;border:1px solid var(--border);background:rgba(255,255,255,.04);font-size:12px;color:#cbd5e1}
  .deltaBtns button{
    padding:8px 10px;border-radius:12px;border:1px solid var(--border);
    background:rgba(255,255,255,.05);color:var(--text);cursor:pointer;font-weight:700
  }
  .deltaBtns button.plus{border-color:rgba(34,197,94,.35)}
  .deltaBtns button.minus{border-color:rgba(239,68,68,.35)}
  .notice{padding:10px;border-radius:14px;border:1px solid rgba(56,189,248,.25);background:rgba(56,189,248,.08)}
  @media (max-width: 900px){
    .layout{grid-template-columns:1fr}
    .side{position:sticky;top:0;z-index:2}
  }
</style>
</head>
<body>
<div class="layout">
  <aside class="side">
    <div class="brand">
      <div class="dot"></div>
      <div>
        <h1>中文管理後台</h1>
        <div class="muted">使用者：${escapeHtml(ADMIN_USER || "admin")}</div>
      </div>
    </div>

    <div class="nav">
      <button class="active" data-page="dash">🏠 儀表板</button>
      <button data-page="players">👤 玩家查找 / 加減分</button>
      <button data-page="lb">🏆 排行榜</button>
      <button data-page="settings">⚙️ 設定</button>
      <button onclick="location.href='/admin/logout'" class="ghost">🚪 登出</button>
    </div>

    <div style="margin-top:14px" class="card">
      <div class="muted">提示</div>
      <div style="margin-top:6px" class="muted">
        玩家這頁是「搜尋」模式，不會列整個伺服器成員。
      </div>
    </div>
  </aside>

  <main class="main">
    <div class="topbar">
      <div class="pill">
        <img id="guildIcon" alt="" />
        <div>
          <div style="font-weight:800">目前伺服器</div>
          <div class="muted" id="guildName">（讀取中...）</div>
        </div>
      </div>

      <div class="row">
        <select id="guildSelect"></select>
        <button class="btn ghost" onclick="reloadAll()">重新載入</button>
      </div>
    </div>

    <section id="page_dash" class="grid">
      <div class="card">
        <h2>狀態</h2>
        <div class="notice">
          ✅ 後台已啟動<br/>
          <span class="muted">如果你機器人回覆慢，通常是 Firebase 認證或指令內部寫法造成，後台本身不應該慢。</span>
        </div>
      </div>

      <div class="card">
        <h2>快速操作</h2>
        <div class="row">
          <button class="btn" onclick="go('players')">去玩家查找</button>
          <button class="btn ghost" onclick="go('lb')">看排行榜</button>
          <button class="btn ghost" onclick="go('settings')">改設定</button>
        </div>
      </div>
    </section>

    <section id="page_players" class="grid" style="display:none">
      <div class="card">
        <h2>搜尋玩家（不列全員）</h2>
        <div class="muted">輸入至少 2 個字，例如：暱稱、使用者名稱的一部分</div>
        <div class="row" style="margin-top:10px">
          <input id="q" placeholder="輸入玩家名稱..." style="flex:1;min-width:220px" />
          <button class="btn" onclick="searchMember()">搜尋</button>
        </div>
        <div id="searchResult" style="margin-top:12px" class="muted">（尚未搜尋）</div>
      </div>

      <div class="card" id="playerCard" style="display:none">
        <h2>玩家分數管理</h2>
        <div class="row" style="justify-content:space-between">
          <div class="u">
            <img id="pAvatar" alt="" />
            <div>
              <div style="font-weight:900" id="pName">-</div>
              <div class="muted mono" id="pId">-</div>
            </div>
          </div>
          <div class="tag">目前分數：<span class="mono" id="pPoints">0</span></div>
        </div>

        <div class="row" style="margin-top:12px">
          <div class="deltaBtns row">
            <button class="plus" onclick="adjust(+1)">+1</button>
            <button class="plus" onclick="adjust(+5)">+5</button>
            <button class="plus" onclick="adjust(+10)">+10</button>
            <button class="minus" onclick="adjust(-1)">-1</button>
            <button class="minus" onclick="adjust(-5)">-5</button>
            <button class="minus" onclick="adjust(-10)">-10</button>
          </div>
          <div class="row" style="margin-left:auto">
            <input id="customDelta" placeholder="自訂（例如 25 或 -40）" style="width:220px" />
            <button class="btn ghost" onclick="adjustCustom()">套用</button>
          </div>
        </div>

        <div class="muted" style="margin-top:10px">加減分會即時寫入 Firebase（transaction 防打架）。</div>
      </div>
    </section>

    <section id="page_lb" class="grid" style="display:none">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div>
            <h2>排行榜</h2>
            <div class="muted">顯示頭像與姓名（抓不到時會顯示 ID）</div>
          </div>
          <button class="btn" onclick="loadLeaderboard()">重新載入</button>
        </div>
        <div id="lbBox" class="muted" style="margin-top:10px">載入中...</div>
      </div>
    </section>

    <section id="page_settings" class="grid" style="display:none">
      <div class="card">
        <h2>設定（中文表單）</h2>
        <div class="muted">這裡是「後台存設定」，你的 bot 需要自己去讀 settings/{guildId} 或 settings/global 才會生效。</div>

        <div style="margin-top:12px" class="row">
          <div style="flex:1;min-width:250px">
            <div class="muted">是否啟用遊戲</div>
            <select id="set_gameEnabled" style="width:100%">
              <option value="true">啟用</option>
              <option value="false">停用</option>
            </select>
          </div>
          <div style="flex:1;min-width:250px">
            <div class="muted">是否啟用積分</div>
            <select id="set_pointsEnabled" style="width:100%">
              <option value="true">啟用</option>
              <option value="false">停用</option>
            </select>
          </div>
          <div style="flex:1;min-width:250px">
            <div class="muted">冷卻秒數（避免洗頻）</div>
            <input id="set_cooldownSec" type="number" min="0" step="1" style="width:100%" />
          </div>
        </div>

        <div class="row" style="margin-top:12px;justify-content:flex-end">
          <button class="btn ghost" onclick="loadSettings()">讀取</button>
          <button class="btn" onclick="saveSettings()">儲存</button>
        </div>

        <div class="muted" id="setStatus" style="margin-top:10px"></div>
      </div>
    </section>

  </main>
</div>

<script>
  const DEFAULT_SETTINGS = ${JSON.stringify(defaultSettings)};

  let currentGuildId = "global";
  let selectedUserId = null;
  let selectedUserInfo = null;

  function esc(s){ return String(s||"").replace(/[&<>"']/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

  async function api(url, opts){
    const res = await fetch(url, { headers: { "Content-Type":"application/json" }, ...opts });
    const json = await res.json().catch(()=>null);
    if(!res.ok || !json || json.ok === false){
      throw new Error((json && json.error) || ("HTTP_"+res.status));
    }
    return json;
  }

  function go(page){
    document.querySelectorAll(".nav button[data-page]").forEach(b=>{
      b.classList.toggle("active", b.dataset.page === page);
    });

    ["dash","players","lb","settings"].forEach(p=>{
      const el = document.getElementById("page_"+p);
      if(!el) return;
      el.style.display = (p===page) ? "" : "none";
    });
  }

  document.querySelectorAll(".nav button[data-page]").forEach(b=>{
    b.addEventListener("click", ()=>go(b.dataset.page));
  });

  async function initGuilds(){
    const j = await api("/admin/api/guilds");
    const guilds = j.guilds || [];
    const sel = document.getElementById("guildSelect");
    sel.innerHTML = "";

    // 允許 global
    const opt0 = document.createElement("option");
    opt0.value = "global";
    opt0.textContent = "（全域 / global）";
    sel.appendChild(opt0);

    for(const g of guilds){
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.name;
      opt.dataset.icon = g.icon || "";
      sel.appendChild(opt);
    }

    sel.value = currentGuildId;
    sel.onchange = ()=>{
      currentGuildId = sel.value;
      refreshGuildPill();
      // 切伺服器時，清掉玩家選取
      clearSelectedUser();
      loadSettings();
    };

    refreshGuildPill();
  }

  function refreshGuildPill(){
    const sel = document.getElementById("guildSelect");
    const nameEl = document.getElementById("guildName");
    const iconEl = document.getElementById("guildIcon");
    const opt = sel.options[sel.selectedIndex];
    if(!opt) return;

    nameEl.textContent = opt.textContent;
    const icon = opt.dataset.icon || "";
    if(icon){
      iconEl.src = icon;
      iconEl.style.display = "";
    }else{
      iconEl.removeAttribute("src");
      iconEl.style.display = "none";
    }
  }

  function clearSelectedUser(){
    selectedUserId = null;
    selectedUserInfo = null;
    document.getElementById("playerCard").style.display = "none";
    document.getElementById("searchResult").textContent = "（尚未搜尋）";
  }

  async function searchMember(){
    const q = document.getElementById("q").value.trim();
    const out = document.getElementById("searchResult");
    out.textContent = "搜尋中...";

    if(currentGuildId === "global"){
      out.textContent = "請先選擇一個伺服器（global 無法搜尋成員）";
      return;
    }
    if(q.length < 2){
      out.textContent = "請輸入至少 2 個字再搜尋";
      return;
    }

    try{
      const j = await api("/admin/api/member/search?guildId="+encodeURIComponent(currentGuildId)+"&q="+encodeURIComponent(q));
      const members = j.members || [];
      if(!members.length){
        out.textContent = "找不到符合的人（換個關鍵字試試）";
        return;
      }

      // 顯示成「搜尋結果」，不是全員列表（只顯示 1~10 筆）
      out.innerHTML =
        '<div class="muted" style="margin-bottom:8px">搜尋結果（點選一個人管理分數）</div>' +
        members.map(m=>(
          '<div class="row" style="padding:10px;border:1px solid rgba(255,255,255,.10);border-radius:14px;margin:8px 0;cursor:pointer" onclick="pickUser(\\''+esc(m.id)+'\\',\\''+esc(m.name)+'\\',\\''+esc(m.avatar)+'\\',\\''+esc(m.username)+'\\')">' +
            '<div class="u"><img src="'+esc(m.avatar)+'"/><div>' +
              '<div style="font-weight:900">'+esc(m.name)+'</div>' +
              '<div class="muted mono">@'+esc(m.username)+' · '+esc(m.id)+'</div>' +
            '</div></div>' +
          '</div>'
        )).join("");
    }catch(e){
      out.textContent = "搜尋失敗：" + e.message;
    }
  }

  async function pickUser(id, name, avatar, username){
    selectedUserId = id;
    selectedUserInfo = { id, name, avatar, username };

    document.getElementById("pAvatar").src = avatar;
    document.getElementById("pName").textContent = name;
    document.getElementById("pId").textContent = id;

    document.getElementById("playerCard").style.display = "";
    await refreshPoints();
  }

  async function refreshPoints(){
    if(!selectedUserId) return;
    const j = await api("/admin/api/points/get?userId="+encodeURIComponent(selectedUserId));
    document.getElementById("pPoints").textContent = String(j.points ?? 0);
  }

  async function adjust(delta){
    if(!selectedUserId) return alert("請先選擇一位玩家");
    try{
      const j = await api("/admin/api/points/adjust", {
        method:"POST",
        body: JSON.stringify({ userId: selectedUserId, delta })
      });
      document.getElementById("pPoints").textContent = String(j.after ?? 0);
    }catch(e){
      alert("加減分失敗：" + e.message);
    }
  }

  async function adjustCustom(){
    const v = document.getElementById("customDelta").value.trim();
    const n = Number(v);
    if(!Number.isFinite(n)) return alert("自訂數值格式錯誤");
    await adjust(n);
  }

  async function loadLeaderboard(){
    const box = document.getElementById("lbBox");
    box.textContent = "載入中...";
    try{
      const j = await api("/admin/api/leaderboard?top=20");
      const rows = j.rows || [];
      if(!rows.length){
        box.innerHTML = "<div class='muted'>（目前沒有任何分數資料）</div>";
        return;
      }

      // 先做 resolve（把 userId 轉成名字與頭像）
      const ids = rows.map(r=>r.userId);
      const rr = await api("/admin/api/users/resolve", { method:"POST", body: JSON.stringify({ ids }) });
      const users = rr.users || {};

      let html = "<table><thead><tr><th>#</th><th>玩家</th><th>分數</th></tr></thead><tbody>";
      rows.forEach((r,i)=>{
        const u = users[r.userId];
        const name = u ? u.name : r.userId;
        const avatar = u ? u.avatar : "";
        html += "<tr>";
        html += "<td class='mono'>"+(i+1)+"</td>";
        html += "<td>";
        html += "<div class='u'>";
        html += avatar ? "<img src='"+esc(avatar)+"'/>" : "<img/>";
        html += "<div><div style='font-weight:900'>"+esc(name)+"</div>";
        html += "<div class='muted mono'>"+esc(r.userId)+"</div></div>";
        html += "</div>";
        html += "</td>";
        html += "<td class='mono'>"+esc(r.points)+"</td>";
        html += "</tr>";
      });
      html += "</tbody></table>";
      box.innerHTML = html;
    }catch(e){
      box.textContent = "載入失敗：" + e.message;
    }
  }

  async function loadSettings(){
    const status = document.getElementById("setStatus");
    status.textContent = "讀取中...";
    try{
      const j = await api("/admin/api/settings?guildId="+encodeURIComponent(currentGuildId));
      const s = Object.assign({}, DEFAULT_SETTINGS, j.settings || {});
      document.getElementById("set_gameEnabled").value = String(Boolean(s.gameEnabled));
      document.getElementById("set_pointsEnabled").value = String(Boolean(s.pointsEnabled));
      document.getElementById("set_cooldownSec").value = Number(s.cooldownSec ?? 0);
      status.textContent = "已讀取 ✅";
    }catch(e){
      status.textContent = "讀取失敗：" + e.message;
    }
  }

  async function saveSettings(){
    const status = document.getElementById("setStatus");
    status.textContent = "儲存中...";
    try{
      const payload = {
        gameEnabled: document.getElementById("set_gameEnabled").value === "true",
        pointsEnabled: document.getElementById("set_pointsEnabled").value === "true",
        cooldownSec: Number(document.getElementById("set_cooldownSec").value || 0),
      };
      await api("/admin/api/settings?guildId="+encodeURIComponent(currentGuildId), {
        method:"POST",
        body: JSON.stringify(payload)
      });
      status.textContent = "已儲存 ✅（bot 端需要自己去讀設定才會生效）";
    }catch(e){
      status.textContent = "儲存失敗：" + e.message;
    }
  }

  async function reloadAll(){
    await initGuilds();
    await loadSettings();
    // 不自動刷新玩家，避免誤刷
    // 排行榜留在使用者點才載入
  }

  // init
  (async ()=>{
    await initGuilds();
    await loadSettings();
    go("dash");
  })();
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}