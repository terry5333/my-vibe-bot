"use strict";

/**
 * src/web/server.js
 * 中文後台：側邊選單 / 玩家列表(分頁) / 加減分 / 排行榜 / 中文設定
 */

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");

// ============ Firebase ============
let _db = null;

function getDb() {
  if (_db) return _db;

  if (!admin.apps.length) {
    const rawUrl =
      process.env.FIREBASE_DB_URL ||
      process.env.FIREBASE_DATABASE_URL ||
      process.env.DATABASE_URL;

    if (!rawUrl) throw new Error("❌ 缺少 FIREBASE_DB_URL");

    // 只取 origin（避免貼到 console 網址）
    const url = new URL(rawUrl).origin;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        databaseURL: url,
      });
    } else {
      admin.initializeApp({ databaseURL: url });
    }
  }

  _db = admin.database();
  return _db;
}

function pointsRef(userId) {
  return getDb().ref(`points/${userId}`);
}
function settingsRef(guildId) {
  return getDb().ref(`settings/${guildId || "global"}`);
}

// ============ Express ============
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ============ ENV ============
const { JWT_SECRET, ADMIN_USER, ADMIN_PASS } = process.env;
if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.error("❌ 缺少 ENV：JWT_SECRET / ADMIN_USER / ADMIN_PASS");
}

// ============ Runtime（給 web 拿到 discord client） ============
const runtime = { app, client: null };

function attachRuntime(webRuntime, { client }) {
  if (webRuntime && typeof webRuntime === "object") webRuntime.client = client;
  runtime.client = client;
  return webRuntime;
}

// ============ Helpers ============
function isHttps(req) {
  return !!(req.secure || req.headers["x-forwarded-proto"] === "https");
}
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
function ok(res, data = {}) {
  return res.json({ ok: true, ...data });
}
function bad(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg || "ERROR" });
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
  if (!token) return bad(res, 401, "UNAUTH");
  try {
    verifyToken(token);
    return next();
  } catch {
    return bad(res, 401, "UNAUTH");
  }
}

// ============ Base ============
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => ok(res, { status: "ok" }));

// ============ Login ============
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

// ============ Admin UI ============
app.get("/admin", authPage, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(adminHtml());
});

// ============ API: guilds ============
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
    return bad(res, 500, "GUILDS_FAILED");
  }
});

/**
 * ✅ API：列成員（分頁）
 * GET /admin/api/members/list?guildId=xxx&limit=25&after=USER_ID
 *
 * 注意：要完整列出成員，建議開 SERVER MEMBERS INTENT + intents 加 GuildMembers
 */
app.get("/admin/api/members/list", authApi, async (req, res) => {
  try {
    const client = runtime.client;
    if (!client) return ok(res, { members: [], nextAfter: null });

    const guildId = String(req.query?.guildId || "");
    if (!guildId || guildId === "global") return bad(res, 400, "NEED_GUILD_ID");

    const limit = Math.max(5, Math.min(50, Number(req.query?.limit || 25)));
    const after = String(req.query?.after || "").trim() || undefined;

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return bad(res, 404, "GUILD_NOT_FOUND");

    // 用 REST 列表（比較穩定，分頁）
    // discord.js v14：client.rest + Routes
    const { Routes } = require("discord-api-types/v10");

    const query = new URLSearchParams();
    query.set("limit", String(limit));
    if (after) query.set("after", after);

    const arr = await client.rest.get(
      Routes.guildMembers(guildId),
      { query }
    );

    const members = (Array.isArray(arr) ? arr : []).map((m) => ({
      id: m.user?.id,
      name: m.user?.global_name || m.user?.username || m.user?.id,
      username: m.user?.username || "",
      avatar: m.user?.avatar
        ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${Number(m.user?.discriminator || 0) % 5}.png`,
    })).filter((x) => x.id);

    const nextAfter = members.length ? members[members.length - 1].id : null;
    return ok(res, { members, nextAfter });
  } catch (e) {
    console.error("[Web] members list error:", e);
    return bad(res, 500, "MEMBERS_LIST_FAILED");
  }
});

/**
 * ✅ API：批次取得分數（避免一個人打一次 DB）
 * POST /admin/api/points/batchGet  { ids: ["..."] }
 */
app.post("/admin/api/points/batchGet", authApi, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 60) : [];
    if (!ids.length) return ok(res, { points: {} });

    const snap = await getDb().ref("points").get();
    const all = snap.val() || {};

    const points = {};
    for (const id of ids) points[id] = Number(all[id] ?? 0);

    return ok(res, { points });
  } catch (e) {
    console.error("[Web] points batchGet error:", e);
    return bad(res, 500, "POINTS_BATCH_FAILED");
  }
});

// 單人 get
app.get("/admin/api/points/get", authApi, async (req, res) => {
  try {
    const userId = String(req.query?.userId || "");
    if (!userId) return bad(res, 400, "BAD_REQUEST");

    const snap = await pointsRef(userId).get();
    return ok(res, { userId, points: Number(snap.val() ?? 0) });
  } catch (e) {
    console.error("[Web] points get error:", e);
    return bad(res, 500, "POINTS_GET_FAILED");
  }
});

// 加減分（transaction）
app.post("/admin/api/points/adjust", authApi, async (req, res) => {
  try {
    const { userId, delta } = req.body || {};
    const uid = String(userId || "").trim();
    const d = Number(delta);

    if (!uid || !Number.isFinite(d)) return bad(res, 400, "BAD_REQUEST");

    const ref = pointsRef(uid);
    const result = await ref.transaction((cur) => Number(cur ?? 0) + d);
    if (!result.committed) return bad(res, 500, "TX_NOT_COMMITTED");

    return ok(res, { userId: uid, after: Number(result.snapshot.val() ?? 0) });
  } catch (e) {
    console.error("[Web] points adjust error:", e);
    return bad(res, 500, "ADJUST_FAILED");
  }
});

// 排行榜
app.get("/admin/api/leaderboard", authApi, async (req, res) => {
  try {
    const top = Math.max(1, Math.min(100, Number(req.query?.top || 20)));

    const snap = await getDb().ref("points").get();
    const obj = snap.val() || {};

    const rows = Object.entries(obj)
      .map(([userId, points]) => ({ userId, points: Number(points ?? 0) }))
      .sort((a, b) => b.points - a.points)
      .slice(0, top);

    return ok(res, { rows });
  } catch (e) {
    console.error("[Web] leaderboard error:", e);
    return bad(res, 500, "LEADERBOARD_FAILED");
  }
});

// 解析 user 資訊（給排行榜）
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
    return bad(res, 500, "USERS_RESOLVE_FAILED");
  }
});

// 設定（中文表單）
app.get("/admin/api/settings", authApi, async (req, res) => {
  try {
    const guildId = String(req.query?.guildId || "global");
    const snap = await settingsRef(guildId).get();
    return ok(res, { settings: snap.val() || {} });
  } catch (e) {
    console.error("[Web] settings get error:", e);
    return bad(res, 500, "SETTINGS_FAILED");
  }
});

app.post("/admin/api/settings", authApi, async (req, res) => {
  try {
    const guildId = String(req.query?.guildId || "global");
    await settingsRef(guildId).set(req.body || {});
    return ok(res, { saved: true });
  } catch (e) {
    console.error("[Web] settings save error:", e);
    return bad(res, 500, "SETTINGS_SAVE_FAILED");
  }
});

// 404
app.use((req, res) => res.status(404).send("Not Found"));

// start
function startWeb() {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => console.log(`[Web] listening on ${PORT}`));
  return runtime;
}

module.exports = { startWeb, attachRuntime, app };

// ================= HTML =================
function loginHtml(showErr) {
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>管理員登入</title>
<style>
  :root{--bg:#0b1220;--card:rgba(255,255,255,.06);--border:rgba(255,255,255,.10);--text:#e5e7eb;--muted:#9ca3af;--pri:#38bdf8;--bad:#ef4444;}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 500px at 20% 10%, rgba(56,189,248,.25), transparent), var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC";}
  .box{width:min(420px,92vw);background:var(--card);border:1px solid var(--border);border-radius:18px;padding:22px;backdrop-filter:blur(10px)}
  h1{margin:0 0 10px;font-size:18px}
  .muted{color:var(--muted);font-size:12px;margin-bottom:14px}
  input,button{width:100%;padding:12px;border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--text);outline:none}
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
  const defaultSettings = {
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
    --border:rgba(255,255,255,.10);
    --text:#e5e7eb;
    --muted:#9ca3af;
    --pri:#38bdf8;
    --pri2:#6366f1;
    --bad:#ef4444;
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
  .side{padding:18px;border-right:1px solid var(--border);background:rgba(0,0,0,.18);backdrop-filter:blur(10px)}
  .brand{display:flex;gap:10px;align-items:center;padding:12px;border:1px solid var(--border);background:var(--panel);border-radius:16px}
  .dot{width:14px;height:14px;border-radius:999px;background:linear-gradient(180deg,var(--pri),var(--pri2));box-shadow:0 0 22px rgba(56,189,248,.35)}
  .brand h1{font-size:14px;margin:0}
  .muted{color:var(--muted);font-size:12px}
  .nav{margin-top:14px;display:flex;flex-direction:column;gap:8px}
  .nav button{
    width:100%;text-align:left;padding:12px;border-radius:14px;border:1px solid var(--border);
    background:rgba(255,255,255,.04);color:var(--text);cursor:pointer;font-weight:650
  }
  .nav button.active{background:linear-gradient(90deg, rgba(56,189,248,.22), rgba(99,102,241,.18));border-color:rgba(56,189,248,.35)}
  .main{padding:18px 18px 50px}
  .topbar{
    display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between;
    padding:14px;border:1px solid var(--border);background:var(--panel);border-radius:18px;
  }
  .pill{display:flex;align-items:center;gap:10px;border:1px solid var(--border);background:rgba(255,255,255,.04);padding:10px 12px;border-radius:999px}
  .pill img{width:28px;height:28px;border-radius:8px;object-fit:cover}
  select,input{border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--text);padding:10px 12px;outline:none}
  .btn{border:none;background:linear-gradient(90deg, rgba(56,189,248,.9), rgba(99,102,241,.9));color:#07101f;font-weight:800;padding:10px 12px;border-radius:12px;cursor:pointer}
  .btn.ghost{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--border);font-weight:700}
  .grid{margin-top:14px;display:grid;grid-template-columns:1fr;gap:12px}
  .card{border:1px solid var(--border);background:var(--panel);border-radius:18px;padding:14px}
  .card h2{margin:0 0 10px;font-size:16px}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  table{width:100%;border-collapse:collapse}
  th,td{border-bottom:1px solid rgba(255,255,255,.10);padding:10px;text-align:left;vertical-align:middle}
  th{color:#cbd5e1;font-size:12px}
  .u{display:flex;gap:10px;align-items:center}
  .u img{width:34px;height:34px;border-radius:12px;object-fit:cover;background:rgba(255,255,255,.06)}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono";font-size:12px}
  .deltaBtns button{
    padding:8px 10px;border-radius:12px;border:1px solid var(--border);
    background:rgba(255,255,255,.05);color:var(--text);cursor:pointer;font-weight:700
  }
  .deltaBtns button.plus{border-color:rgba(34,197,94,.35)}
  .deltaBtns button.minus{border-color:rgba(239,68,68,.35)}
  @media (max-width: 900px){.layout{grid-template-columns:1fr}.side{position:sticky;top:0;z-index:2}}
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
      <button data-page="players">👥 玩家列表 / 加減分</button>
      <button data-page="lb">🏆 排行榜</button>
      <button data-page="settings">⚙️ 設定</button>
      <button onclick="location.href='/admin/logout'" class="ghost">🚪 登出</button>
    </div>

    <div style="margin-top:14px" class="card">
      <div class="muted">注意</div>
      <div style="margin-top:6px" class="muted">
        要列完整成員：Developer Portal 開 SERVER MEMBERS INTENT，
        程式端 intents 加 GuildMembers。
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
        <div class="muted">✅ 後台已啟動</div>
      </div>
    </section>

    <section id="page_players" class="grid" style="display:none">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div>
            <h2>玩家列表（分頁載入）</h2>
            <div class="muted">點「載入更多」會接著載下一頁，不會一次炸全伺服器。</div>
          </div>
          <div class="row">
            <select id="pageSize">
              <option value="10">10 / 頁</option>
              <option value="25" selected>25 / 頁</option>
              <option value="50">50 / 頁</option>
            </select>
            <button class="btn ghost" onclick="resetMembers()">重置</button>
            <button class="btn" onclick="loadMoreMembers()">載入更多</button>
          </div>
        </div>

        <div id="membersBox" class="muted" style="margin-top:10px">（尚未載入）</div>
      </div>
    </section>

    <section id="page_lb" class="grid" style="display:none">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div>
            <h2>排行榜</h2>
            <div class="muted">顯示頭像與姓名（抓不到就顯示 ID）</div>
          </div>
          <button class="btn" onclick="loadLeaderboard()">重新載入</button>
        </div>
        <div id="lbBox" class="muted" style="margin-top:10px">載入中...</div>
      </div>
    </section>

    <section id="page_settings" class="grid" style="display:none">
      <div class="card">
        <h2>設定（中文表單）</h2>
        <div class="muted">注意：後台只是「存設定」，你的 bot 要自己去讀 settings 才會生效。</div>

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
  let members = [];          // 已載入的成員
  let nextAfter = null;      // 分頁游標
  let loading = false;

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

    // 頁面切到排行榜時才載入
    if(page === "lb") loadLeaderboard();
  }

  document.querySelectorAll(".nav button[data-page]").forEach(b=>{
    b.addEventListener("click", ()=>go(b.dataset.page));
  });

  async function initGuilds(){
    const j = await api("/admin/api/guilds");
    const guilds = j.guilds || [];
    const sel = document.getElementById("guildSelect");
    sel.innerHTML = "";

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
      resetMembers();
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

  function resetMembers(){
    members = [];
    nextAfter = null;
    renderMembers();
    document.getElementById("membersBox").textContent = "（已重置，點「載入更多」開始載入）";
  }

  async function loadMoreMembers(){
    if(loading) return;
    if(currentGuildId === "global"){
      document.getElementById("membersBox").textContent = "請先選擇一個伺服器（global 無法列成員）";
      return;
    }

    loading = true;
    const box = document.getElementById("membersBox");
    box.textContent = "載入中...";

    try{
      const limit = Number(document.getElementById("pageSize").value || 25);
      const url = "/admin/api/members/list?guildId="+encodeURIComponent(currentGuildId)+"&limit="+limit + (nextAfter ? "&after="+encodeURIComponent(nextAfter) : "");
      const j = await api(url);
      const newMembers = j.members || [];
      nextAfter = j.nextAfter || null;

      // 合併、去重
      const seen = new Set(members.map(x=>x.id));
      for(const m of newMembers){
        if(!seen.has(m.id)){
          members.push(m);
          seen.add(m.id);
        }
      }

      // 批次拿分數
      const ids = newMembers.map(x=>x.id);
      const pj = await api("/admin/api/points/batchGet", { method:"POST", body: JSON.stringify({ ids }) });
      const pointsMap = pj.points || {};
      for(const m of members){
        if(pointsMap[m.id] !== undefined) m.points = pointsMap[m.id];
        if(m.points === undefined) m.points = 0;
      }

      renderMembers();
    }catch(e){
      box.textContent = "載入失敗：" + e.message;
    }finally{
      loading = false;
    }
  }

  function renderMembers(){
    const box = document.getElementById("membersBox");
    if(!members.length){
      box.innerHTML = "<div class='muted'>（尚未載入）</div>";
      return;
    }

    let html = "<table><thead><tr><th>玩家</th><th>ID</th><th>分數</th><th>加減分</th></tr></thead><tbody>";

    for(const m of members){
      html += "<tr>";
      html += "<td><div class='u'><img src='"+esc(m.avatar)+"'/><div><div style='font-weight:900'>"+esc(m.name)+"</div><div class='muted mono'>@"+esc(m.username)+"</div></div></div></td>";
      html += "<td class='mono'>"+esc(m.id)+"</td>";
      html += "<td class='mono' id='pt_"+esc(m.id)+"'>"+esc(m.points ?? 0)+"</td>";
      html += "<td><div class='deltaBtns row'>"
           +  "<button class='plus' onclick='adjust(\""+esc(m.id)+"\",1)'>+1</button>"
           +  "<button class='plus' onclick='adjust(\""+esc(m.id)+"\",5)'>+5</button>"
           +  "<button class='plus' onclick='adjust(\""+esc(m.id)+"\",10)'>+10</button>"
           +  "<button class='minus' onclick='adjust(\""+esc(m.id)+"\",-1)'>-1</button>"
           +  "<button class='minus' onclick='adjust(\""+esc(m.id)+"\",-5)'>-5</button>"
           +  "<button class='minus' onclick='adjust(\""+esc(m.id)+"\",-10)'>-10</button>"
           + "</div></td>";
      html += "</tr>";
    }
    html += "</tbody></table>";

    html += "<div class='muted' style='margin-top:10px'>已載入 "+members.length+" 人"
         +  (nextAfter ? "｜可再載入更多" : "｜看起來已到最後一頁")
         +  "</div>";

    box.innerHTML = html;
  }

  async function adjust(userId, delta){
    try{
      const j = await api("/admin/api/points/adjust", {
        method:"POST",
        body: JSON.stringify({ userId, delta })
      });
      const el = document.getElementById("pt_"+userId);
      if(el) el.textContent = String(j.after ?? 0);
      // 同步本地
      const m = members.find(x=>x.id===userId);
      if(m) m.points = j.after ?? m.points;
    }catch(e){
      alert("加減分失敗：" + e.message);
    }
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
        html += "<td><div class='u'>"+(avatar?("<img src='"+esc(avatar)+"'/>"):"<img/>")+"<div><div style='font-weight:900'>"+esc(name)+"</div><div class='muted mono'>"+esc(r.userId)+"</div></div></div></td>";
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
      status.textContent = "已儲存 ✅";
    }catch(e){
      status.textContent = "儲存失敗：" + e.message;
    }
  }

  async function reloadAll(){
    await initGuilds();
    await loadSettings();
    resetMembers();
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