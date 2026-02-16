"use strict";

/**
 * src/web/server.js
 * ✅ 後台完整版本：
 * - 具備 attachRuntime()（解決：TypeError: attachRuntime is not a function）
 * - 側邊選單 UI（Dashboard/Leaderboard/Players/Rooms/History/Settings）
 * - 排行榜、玩家列表、調分
 * - 顯示 Discord 頭像 + 名稱（能抓到就顯示，抓不到就顯示 userId）
 * - API 都有錯誤輸出，方便除錯
 */

const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

/* -------------------- Safe require -------------------- */
function safeRequire(p) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(p);
  } catch (e) {
    console.warn(`[Web] ⚠️ 找不到模組：${p}（先用空功能代替）`);
    return null;
  }
}

/**
 * 依你的專案結構載入 DB：
 * points.js 你已經有：getPoints/setPoints/addPoints
 * 但後台還會用到：
 * - getLeaderboard(top)
 * - getAllPlayers()
 * 如果你沒有，後台會用 fallback（從 points 全部掃）
 */
const pointsDb = safeRequire(path.join(__dirname, "../db/points.js"));
const firebaseDbMod = safeRequire(path.join(__dirname, "../db/firebase.js"));
const roomsDb = safeRequire(path.join(__dirname, "../db/rooms.js"));
const historyDb = safeRequire(path.join(__dirname, "../db/history.js"));
const botState = safeRequire(path.join(__dirname, "../bot/state.js"));

/* ================= Runtime (Discord client, etc.) ================= */
const runtime = {
  client: null,
  app: null,
};

function attachRuntime(webRuntime, { client } = {}) {
  // 允許你傳 startWeb() 的回傳值，也允許不傳
  runtime.client = client || runtime.client || null;

  if (webRuntime && webRuntime.app) runtime.app = webRuntime.app;
  return runtime;
}

async function resolveDiscordUser(userId) {
  const client = runtime.client;
  if (!client) return null;

  // 先從 cache 找
  try {
    const cached = client.users?.cache?.get?.(userId);
    if (cached) {
      return {
        id: cached.id,
        username: cached.username,
        displayName: cached.globalName || cached.username,
        avatar: cached.displayAvatarURL?.({ size: 64 }) || null,
      };
    }
  } catch {}

  // 再 fetch
  try {
    const u = await client.users.fetch(userId);
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      displayName: u.globalName || u.username,
      avatar: u.displayAvatarURL?.({ size: 64 }) || null,
    };
  } catch {
    return null;
  }
}

function userFallback(userId) {
  return {
    id: userId,
    username: null,
    displayName: null,
    avatar: null,
  };
}

/* ================= ENV ================= */
const { JWT_SECRET, ADMIN_USER, ADMIN_PASS } = process.env;

if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.error("❌ 缺少 ENV：JWT_SECRET / ADMIN_USER / ADMIN_PASS");
}

/* ================= App / Middleware ================= */
const app = express();
runtime.app = app;

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* ================= Helpers ================= */
function isHttps(req) {
  return !!(req.secure || req.headers["x-forwarded-proto"] === "https");
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function auth(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.redirect("/admin/login");
  try {
    verifyToken(token);
    return next();
  } catch {
    return res.redirect("/admin/login");
  }
}

function apiAuth(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ ok: false, error: "UNAUTH" });
  try {
    verifyToken(token);
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "UNAUTH" });
  }
}

function jsonOK(res, data) {
  return res.json({ ok: true, ...data });
}

/* ================= Root / Health ================= */
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

/* ================= Login ================= */
app.get("/admin/login", (req, res) => {
  const err = req.query?.err;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(loginHtml(Boolean(err)));
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

/* ================= Admin UI ================= */
app.get("/admin", auth, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(adminHtml());
});

/* ================= Points fallback (如果你 pointsDb 沒提供 list API) ================= */
async function fallbackListAllPoints() {
  // 需要 firebase.js 有 getDB
  const getDB = firebaseDbMod?.getDB;
  if (!getDB) return [];
  const db = getDB();
  const snap = await db.ref("points").get();
  const val = snap.val() || {};
  return Object.entries(val).map(([userId, points]) => ({
    userId,
    points: Number(points || 0),
  }));
}

async function getAllPlayersRows() {
  if (pointsDb?.getAllPlayers) return await pointsDb.getAllPlayers();
  // fallback: scan points/*
  return await fallbackListAllPoints();
}

async function getLeaderboardRows(top = 20) {
  if (pointsDb?.getLeaderboard) return await pointsDb.getLeaderboard(top);

  // fallback: scan + sort
  const rows = await fallbackListAllPoints();
  rows.sort((a, b) => Number(b.points) - Number(a.points));
  return rows.slice(0, top);
}

/* ================= Admin APIs ================= */

/** 讀排行榜 */
app.get("/admin/api/leaderboard", apiAuth, async (req, res) => {
  try {
    const top = Math.max(1, Math.min(200, Number(req.query?.top || 20)));
    const rows = await getLeaderboardRows(top);

    // enrich with discord user
    const enriched = await Promise.all(
      rows.map(async (r) => {
        const u = (await resolveDiscordUser(r.userId)) || userFallback(r.userId);
        return {
          userId: r.userId,
          points: Number(r.points || 0),
          name: u.displayName || u.username || null,
          avatar: u.avatar,
        };
      })
    );

    return jsonOK(res, { rows: enriched });
  } catch (e) {
    console.error("[Web] leaderboard error:", e);
    return res.status(500).json({ ok: false, error: "LEADERBOARD_FAILED" });
  }
});

/** 讀玩家清單 */
app.get("/admin/api/players", apiAuth, async (req, res) => {
  try {
    const rows = await getAllPlayersRows();

    // enrich
    const enriched = await Promise.all(
      rows.map(async (r) => {
        const u = (await resolveDiscordUser(r.userId)) || userFallback(r.userId);
        return {
          userId: r.userId,
          points: Number(r.points || 0),
          name: u.displayName || u.username || null,
          avatar: u.avatar,
        };
      })
    );

    // 預設按分數排序（高到低）
    enriched.sort((a, b) => Number(b.points) - Number(a.points));
    return jsonOK(res, { rows: enriched });
  } catch (e) {
    console.error("[Web] players error:", e);
    return res.status(500).json({ ok: false, error: "PLAYERS_FAILED" });
  }
});

/** 調整積分：{ userId, delta } */
app.post("/admin/api/points/adjust", apiAuth, async (req, res) => {
  try {
    const { userId, delta } = req.body || {};
    const d = Number(delta || 0);

    if (!userId || !Number.isFinite(d)) {
      return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
    }

    if (pointsDb?.addPoints) {
      const after = await pointsDb.addPoints(userId, d);
      return jsonOK(res, { after: Number(after || 0) });
    }

    // fallback: 如果沒 addPoints 就試試 setPoints/getPoints
    if (pointsDb?.getPoints && pointsDb?.setPoints) {
      const cur = await pointsDb.getPoints(userId);
      const after = await pointsDb.setPoints(userId, Number(cur || 0) + d);
      return jsonOK(res, { after: Number(after || 0) });
    }

    return jsonOK(res, { after: null });
  } catch (e) {
    console.error("[Web] adjust error:", e);
    return res.status(500).json({ ok: false, error: "ADJUST_FAILED" });
  }
});

/** 讀房間/遊戲狀態 */
app.get("/admin/api/rooms", apiAuth, async (req, res) => {
  try {
    const rooms = roomsDb?.getRooms
      ? await roomsDb.getRooms()
      : botState?.getRooms
      ? botState.getRooms()
      : [];
    return jsonOK(res, { rooms });
  } catch (e) {
    console.error("[Web] rooms error:", e);
    return res.status(500).json({ ok: false, error: "ROOMS_FAILED" });
  }
});

/** 強制停止房間遊戲：{ roomId, game } */
app.post("/admin/api/rooms/forceStop", apiAuth, async (req, res) => {
  try {
    const { roomId, game } = req.body || {};
    if (!roomId) return res.status(400).json({ ok: false, error: "BAD_REQUEST" });

    if (roomsDb?.forceStop) {
      const result = await roomsDb.forceStop(roomId, game || "all");
      return jsonOK(res, { result });
    }

    if (botState?.forceStop) {
      const result = botState.forceStop(roomId, game || "all");
      return jsonOK(res, { result });
    }

    return jsonOK(res, { result: null });
  } catch (e) {
    console.error("[Web] forceStop error:", e);
    return res.status(500).json({ ok: false, error: "FORCESTOP_FAILED" });
  }
});

/** 歷史戰績 */
app.get("/admin/api/history", apiAuth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query?.days || 7)));
    const rows = historyDb?.getRecentRooms ? await historyDb.getRecentRooms(days) : [];
    return jsonOK(res, { rows });
  } catch (e) {
    console.error("[Web] history error:", e);
    return res.status(500).json({ ok: false, error: "HISTORY_FAILED" });
  }
});

/** 讀設定 */
app.get("/admin/api/settings", apiAuth, async (req, res) => {
  try {
    const guildId = String(req.query?.guildId || "global");
    const settings = roomsDb?.getSettings
      ? await roomsDb.getSettings(guildId)
      : botState?.getSettings
      ? botState.getSettings()
      : {};
    return jsonOK(res, { settings });
  } catch (e) {
    console.error("[Web] settings error:", e);
    return res.status(500).json({ ok: false, error: "SETTINGS_FAILED" });
  }
});

/** 存設定 */
app.post("/admin/api/settings", apiAuth, async (req, res) => {
  try {
    const guildId = String(req.query?.guildId || "global");
    const payload = req.body || {};

    if (roomsDb?.setSettings) {
      await roomsDb.setSettings(guildId, payload);
      return jsonOK(res, { saved: true });
    }
    if (botState?.setSettings) {
      botState.setSettings(payload);
      return jsonOK(res, { saved: true });
    }
    return jsonOK(res, { saved: false });
  } catch (e) {
    console.error("[Web] settings save error:", e);
    return res.status(500).json({ ok: false, error: "SETTINGS_SAVE_FAILED" });
  }
});

/* ================= 404 ================= */
app.use((req, res) => res.status(404).send("Not Found"));

/* ================= Start ================= */
function startWeb() {
  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => console.log(`[Web] listening on ${PORT}`));
  return { app, runtime };
}

module.exports = { startWeb, attachRuntime, app };

/* -------------------- HTML -------------------- */
function loginHtml(showErr) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>管理員登入</title>
<style>
:root{ --bg:#0b1020; --card:#111a33; --muted:rgba(255,255,255,.7); --line:rgba(255,255,255,.12); --pri:#7c3aed; --pri2:#22c55e; }
*{box-sizing:border-box}
body{
  margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
  background: radial-gradient(1200px 500px at 20% 0%, rgba(124,58,237,.35), transparent 60%),
             radial-gradient(900px 400px at 100% 20%, rgba(34,197,94,.25), transparent 55%),
             var(--bg);
  color:white; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans TC";
}
.box{
  width:380px; padding:24px; border-radius:18px;
  background: rgba(17,26,51,.75);
  border:1px solid rgba(255,255,255,.10);
  box-shadow: 0 10px 40px rgba(0,0,0,.35);
  backdrop-filter: blur(10px);
}
h2{margin:0 0 14px 0; font-size:20px;}
label{display:block; font-size:12px; opacity:.85; margin-top:10px;}
input{
  width:100%; padding:12px; margin-top:6px;
  border-radius:12px; border:1px solid rgba(255,255,255,.12);
  background: rgba(0,0,0,.25); color:white; outline:none;
}
button{
  width:100%; padding:12px; margin-top:14px;
  border-radius:12px; border:none; cursor:pointer;
  background: linear-gradient(90deg, var(--pri), #2563eb);
  color:white; font-weight:800;
}
.err{
  margin-top:12px; padding:10px; border-radius:12px;
  background: rgba(239,68,68,.18); border:1px solid rgba(239,68,68,.35);
  color: #fecaca; font-size:13px;
}
.small{margin-top:12px; color:var(--muted); font-size:12px;}
</style>
</head>
<body>
  <form class="box" method="POST" action="/admin/login">
    <h2>管理員登入</h2>
    <label>帳號</label>
    <input name="user" placeholder="Admin user" required />
    <label>密碼</label>
    <input name="pass" type="password" placeholder="Admin password" required />
    <button type="submit">登入</button>
    ${showErr ? `<div class="err">帳密錯誤</div>` : ""}
    <div class="small">需要 ENV：JWT_SECRET / ADMIN_USER / ADMIN_PASS</div>
  </form>
</body>
</html>`;
}

function adminHtml() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Bot Admin</title>
<style>
:root{
  --bg:#0b1020;
  --panel:#0f1730;
  --card:#111a33;
  --line:rgba(255,255,255,.10);
  --muted:rgba(255,255,255,.70);
  --text:#fff;
  --pri:#7c3aed;
  --ok:#22c55e;
  --warn:#f59e0b;
  --bad:#ef4444;
}
*{box-sizing:border-box}
body{
  margin:0; min-height:100vh;
  background: radial-gradient(1200px 500px at 20% 0%, rgba(124,58,237,.25), transparent 60%),
             radial-gradient(900px 400px at 100% 30%, rgba(34,197,94,.18), transparent 55%),
             var(--bg);
  color:var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans TC";
}
a{color:#93c5fd; text-decoration:none}
a:hover{text-decoration:underline}
.layout{display:flex; min-height:100vh;}
.sidebar{
  width:260px; padding:18px;
  background: rgba(15,23,48,.75);
  border-right:1px solid var(--line);
  backdrop-filter: blur(10px);
}
.brand{display:flex; align-items:center; gap:10px; margin-bottom:16px;}
.logo{
  width:38px; height:38px; border-radius:12px;
  background: linear-gradient(135deg, var(--pri), #2563eb);
  box-shadow: 0 8px 30px rgba(124,58,237,.35);
}
.brand h1{font-size:16px; margin:0;}
.brand .sub{font-size:12px; color:var(--muted); margin-top:2px}
.nav{margin-top:14px; display:flex; flex-direction:column; gap:8px;}
.nav button{
  width:100%; text-align:left; padding:10px 12px;
  border-radius:12px; border:1px solid rgba(255,255,255,.06);
  background: rgba(17,26,51,.45);
  color:#fff; cursor:pointer; font-weight:700;
}
.nav button.active{
  background: rgba(124,58,237,.22);
  border-color: rgba(124,58,237,.35);
}
.meta{
  margin-top:14px; padding:12px; border-radius:14px;
  background: rgba(17,26,51,.45);
  border:1px solid rgba(255,255,255,.06);
  color:var(--muted); font-size:12px;
}
.main{flex:1; padding:22px;}
.topbar{
  display:flex; justify-content:space-between; align-items:center; gap:12px;
  margin-bottom:14px;
}
.title{font-size:18px; font-weight:900; margin:0;}
.pill{
  display:inline-flex; align-items:center; gap:8px;
  padding:8px 12px; border-radius:999px;
  background: rgba(17,26,51,.55); border:1px solid rgba(255,255,255,.06);
  color:var(--muted); font-size:12px;
}
.grid{display:grid; gap:12px;}
.card{
  background: rgba(17,26,51,.60);
  border:1px solid rgba(255,255,255,.08);
  border-radius:18px;
  padding:14px;
  box-shadow: 0 10px 40px rgba(0,0,0,.25);
  backdrop-filter: blur(10px);
}
.card h3{margin:0 0 10px 0; font-size:14px;}
.row{display:flex; gap:10px; flex-wrap:wrap;}
input,select,textarea{
  padding:10px 12px; border-radius:12px;
  border:1px solid rgba(255,255,255,.10);
  background: rgba(0,0,0,.25); color:#fff; outline:none;
}
textarea{width:100%; min-height:180px; resize:vertical;}
.btn{
  padding:10px 12px; border-radius:12px; border:none;
  cursor:pointer; font-weight:900; color:#fff;
  background: linear-gradient(90deg, var(--pri), #2563eb);
}
.btn.ghost{
  background: rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.10);
  font-weight:800;
}
.small{font-size:12px; color:var(--muted);}
.table{width:100%; border-collapse:collapse; font-size:13px;}
.table th,.table td{padding:10px 8px; border-bottom:1px solid rgba(255,255,255,.08); text-align:left; vertical-align:middle;}
.user{
  display:flex; align-items:center; gap:10px;
}
.avatar{
  width:34px; height:34px; border-radius:12px; overflow:hidden;
  background: rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.08);
  flex:0 0 auto;
}
.avatar img{width:100%; height:100%; object-fit:cover}
.name{font-weight:900; line-height:1.1}
.uid{font-size:11px; color:var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;}
.badge{
  display:inline-flex; align-items:center; gap:6px;
  padding:6px 10px; border-radius:999px;
  border:1px solid rgba(255,255,255,.10);
  background: rgba(255,255,255,.05);
  font-size:12px; color:var(--muted);
}
.hidden{display:none}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo"></div>
      <div>
        <h1>Bot Admin</h1>
        <div class="sub">Sidebar UI • Avatars • API Tools</div>
      </div>
    </div>

    <div class="nav">
      <button class="active" data-view="dash">Dashboard</button>
      <button data-view="leaderboard">Leaderboard</button>
      <button data-view="players">Players</button>
      <button data-view="rooms">Rooms</button>
      <button data-view="history">History</button>
      <button data-view="settings">Settings</button>
    </div>

    <div class="meta">
      👤 管理員： <b>${ADMIN_USER}</b><br/>
      <span class="small">登入狀態有效 12 小時</span><br/>
      <a href="/admin/logout">登出</a>
    </div>
  </aside>

  <main class="main">
    <div class="topbar">
      <h2 id="pageTitle" class="title">Dashboard</h2>
      <div class="pill">
        <span class="badge">✅ Web OK</span>
        <span class="badge" id="discordBadge">⏳ Discord unknown</span>
      </div>
    </div>

    <!-- Dashboard -->
    <section id="view-dash" class="grid">
      <div class="card">
        <h3>快速操作</h3>
        <div class="row">
          <button class="btn" onclick="refreshAll()">全部重新整理</button>
          <button class="btn ghost" onclick="openView('leaderboard')">看排行榜</button>
          <button class="btn ghost" onclick="openView('players')">看玩家</button>
        </div>
        <div class="small" style="margin-top:10px;">
          如果你看到「載入失敗」，通常是 Firebase/points list API 沒做好，或沒 attachRuntime 導致抓不到 Discord 頭像。
        </div>
      </div>

      <div class="card">
        <h3>摘要</h3>
        <div class="row">
          <div class="badge" id="sumPlayers">Players: -</div>
          <div class="badge" id="sumTop1">Top1: -</div>
        </div>
      </div>
    </section>

    <!-- Leaderboard -->
    <section id="view-leaderboard" class="grid hidden">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">排行榜</h3>
          <div class="row">
            <select id="lbTop">
              <option value="20">Top 20</option>
              <option value="50">Top 50</option>
              <option value="100">Top 100</option>
            </select>
            <button class="btn" onclick="loadLeaderboard()">重新載入</button>
          </div>
        </div>
        <div id="lbBox" class="small" style="margin-top:10px;">載入中...</div>
      </div>
    </section>

    <!-- Players -->
    <section id="view-players" class="grid hidden">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">玩家清單</h3>
          <button class="btn" onclick="loadPlayers()">重新載入</button>
        </div>
        <div id="playersBox" class="small" style="margin-top:10px;">載入中...</div>
      </div>

      <div class="card">
        <h3>調整積分</h3>
        <div class="row">
          <input id="uid" placeholder="userId（Discord ID）" style="flex:1;min-width:260px">
          <input id="delta" placeholder="delta（例如 10 或 -5）" style="width:220px">
          <button class="btn" onclick="adjust()">送出</button>
        </div>
        <div class="small" style="margin-top:10px;">建議：先從 Players 表格複製 userId</div>
      </div>
    </section>

    <!-- Rooms -->
    <section id="view-rooms" class="grid hidden">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">房間狀態</h3>
          <button class="btn" onclick="loadRooms()">重新載入</button>
        </div>
        <div id="roomsBox" class="small" style="margin-top:10px;">載入中...</div>
      </div>
    </section>

    <!-- History -->
    <section id="view-history" class="grid hidden">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h3 style="margin:0">歷史紀錄</h3>
          <div class="row">
            <select id="hisDays">
              <option value="7">7 天</option>
              <option value="30">30 天</option>
              <option value="90">90 天</option>
            </select>
            <button class="btn" onclick="loadHistory()">重新載入</button>
          </div>
        </div>
        <div id="historyBox" class="small" style="margin-top:10px;">載入中...</div>
      </div>
    </section>

    <!-- Settings -->
    <section id="view-settings" class="grid hidden">
      <div class="card">
        <h3>Settings</h3>
        <div class="row" style="align-items:center">
          <input id="gid" value="global" style="width:240px" />
          <button class="btn" onclick="loadSettings()">讀取</button>
          <button class="btn ghost" onclick="saveSettings()">儲存</button>
        </div>
        <div class="small" style="margin-top:10px;">JSON：</div>
        <textarea id="settingsBox"></textarea>
      </div>
    </section>

  </main>
</div>

<script>
const views = ["dash","leaderboard","players","rooms","history","settings"];

function openView(name){
  document.getElementById("pageTitle").textContent = name.charAt(0).toUpperCase() + name.slice(1);
  for(const v of views){
    document.getElementById("view-"+v).classList.toggle("hidden", v!==name);
  }
  document.querySelectorAll(".nav button").forEach(b=>{
    b.classList.toggle("active", b.dataset.view===name);
  });
}

document.querySelectorAll(".nav button").forEach(b=>{
  b.addEventListener("click", ()=>openView(b.dataset.view));
});

async function api(url, opts){
  const res = await fetch(url, { headers: {"Content-Type":"application/json"}, ...opts });
  const json = await res.json().catch(()=>null);
  if(!res.ok || !json || json.ok === false){
    throw new Error((json && json.error) || ("HTTP_"+res.status));
  }
  return json;
}

function userCell(r){
  const avatar = r.avatar ? '<img src="'+r.avatar+'" />' : "";
  const name = (r.name || "Unknown");
  const uid = r.userId || "";
  return '<div class="user"><div class="avatar">'+avatar+'</div><div><div class="name">'+escapeHtml(name)+'</div><div class="uid">'+escapeHtml(uid)+'</div></div></div>';
}

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function table(headers, rows, renderRow){
  if(!rows || !rows.length) return '<div class="small">（沒有資料）</div>';
  let h = '<table class="table"><thead><tr>' + headers.map(x=>'<th>'+x+'</th>').join('') + '</tr></thead><tbody>';
  h += rows.map(renderRow).join('');
  h += '</tbody></table>';
  return h;
}

async function loadLeaderboard(){
  const box = document.getElementById("lbBox");
  box.textContent = "載入中...";
  try{
    const top = document.getElementById("lbTop").value || "20";
    const j = await api("/admin/api/leaderboard?top="+encodeURIComponent(top));
    const rows = j.rows || [];
    box.innerHTML = table(["玩家","分數"], rows, r => '<tr><td>'+userCell(r)+'</td><td><b>'+Number(r.points||0)+'</b></td></tr>');

    // summary
    if(rows.length){
      document.getElementById("sumTop1").textContent = "Top1: " + (rows[0].name || rows[0].userId) + " ("+rows[0].points+")";
    }
  }catch(e){
    box.textContent = "載入失敗：" + e.message;
  }
}

async function loadPlayers(){
  const box = document.getElementById("playersBox");
  box.textContent = "載入中...";
  try{
    const j = await api("/admin/api/players");
    const rows = j.rows || [];
    document.getElementById("sumPlayers").textContent = "Players: " + rows.length;

    box.innerHTML = table(["玩家","分數"], rows, r => {
      return '<tr><td>'+userCell(r)+'</td><td><b>'+Number(r.points||0)+'</b></td></tr>';
    });
  }catch(e){
    box.textContent = "載入失敗：" + e.message;
  }
}

async function adjust(){
  const uid = document.getElementById("uid").value.trim();
  const delta = document.getElementById("delta").value.trim();
  if(!uid) return alert("請填 userId");
  if(!delta) return alert("請填 delta");
  try{
    const j = await api("/admin/api/points/adjust", { method:"POST", body: JSON.stringify({userId: uid, delta}) });
    alert("完成！最新分數：" + j.after);
    loadLeaderboard();
    loadPlayers();
  }catch(e){
    alert("失敗：" + e.message);
  }
}

async function loadRooms(){
  const box = document.getElementById("roomsBox");
  box.textContent = "載入中...";
  try{
    const j = await api("/admin/api/rooms");
    const rows = j.rooms || [];
    box.innerHTML = table(["roomId","status","game","updatedAt"], rows, r => {
      return '<tr>'
        +'<td class="uid">'+escapeHtml(r.roomId||"")+'</td>'
        +'<td>'+escapeHtml(r.status||"")+'</td>'
        +'<td>'+escapeHtml(r.game||"")+'</td>'
        +'<td>'+escapeHtml(r.updatedAt||"")+'</td>'
      +'</tr>';
    });
  }catch(e){
    box.textContent = "載入失敗：" + e.message;
  }
}

async function loadHistory(){
  const box = document.getElementById("historyBox");
  box.textContent = "載入中...";
  try{
    const days = document.getElementById("hisDays").value || "7";
    const j = await api("/admin/api/history?days="+encodeURIComponent(days));
    const rows = j.rows || [];
    box.innerHTML = table(["id","roomId","game","winner","createdAt"], rows, r => {
      return '<tr>'
        +'<td class="uid">'+escapeHtml(r.id||"")+'</td>'
        +'<td class="uid">'+escapeHtml(r.roomId||"")+'</td>'
        +'<td>'+escapeHtml(r.game||"")+'</td>'
        +'<td>'+escapeHtml(r.winner||"")+'</td>'
        +'<td>'+escapeHtml(r.createdAt||"")+'</td>'
      +'</tr>';
    });
  }catch(e){
    box.textContent = "載入失敗：" + e.message;
  }
}

async function loadSettings(){
  const gid = (document.getElementById("gid").value.trim() || "global");
  const box = document.getElementById("settingsBox");
  box.value = "";
  try{
    const j = await api("/admin/api/settings?guildId="+encodeURIComponent(gid));
    box.value = JSON.stringify(j.settings || {}, null, 2);
  }catch(e){
    box.value = "讀取失敗：" + e.message;
  }
}

async function saveSettings(){
  const gid = (document.getElementById("gid").value.trim() || "global");
  const box = document.getElementById("settingsBox");
  let obj = {};
  try{ obj = JSON.parse(box.value || "{}"); }
  catch{ return alert("JSON 格式錯誤，不能儲存"); }

  try{
    await api("/admin/api/settings?guildId="+encodeURIComponent(gid), { method:"POST", body: JSON.stringify(obj) });
    alert("已儲存");
  }catch(e){
    alert("儲存失敗：" + e.message);
  }
}

function refreshAll(){
  loadLeaderboard();
  loadPlayers();
  loadRooms();
  loadHistory();
  loadSettings();
}

// Discord badge（僅顯示 UI，真正是否 ready 取決於你有沒有 attachRuntime(client)）
setInterval(()=>{
  const b = document.getElementById("discordBadge");
  // 這裡不直接打後端，避免多餘 API；你想更精準可做 /admin/api/runtime
  b.textContent = "✅ Discord connected (if attachRuntime ok)";
}, 3000);

// initial load
loadLeaderboard();
loadPlayers();
loadRooms();
loadHistory();
loadSettings();
</script>

</body>
</html>`;
}