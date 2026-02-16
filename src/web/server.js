"use strict";

const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

/* -------------------- Safe require -------------------- */
function safeRequire(p) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(p);
  } catch {
    console.warn(`[Web] ⚠️ 找不到模組：${p}（先用空功能代替）`);
    return null;
  }
}

/**
 * 你專案若路徑不同，改這裡：
 *  - points: 讀寫玩家積分
 *  - rooms: 讀寫房間/遊戲狀態
 *  - history: 歷史戰績
 */
const pointsDb = safeRequire(path.join(__dirname, "../db/points.js"));
const roomsDb = safeRequire(path.join(__dirname, "../db/rooms.js"));
const historyDb = safeRequire(path.join(__dirname, "../db/history.js"));
const botState = safeRequire(path.join(__dirname, "../bot/state.js"));

const app = express();

/* ================= ENV ================= */
const { JWT_SECRET, ADMIN_USER, ADMIN_PASS } = process.env;

if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.error("❌ 缺少 ENV：JWT_SECRET / ADMIN_USER / ADMIN_PASS");
}

/* ================= Runtime (給 bot/events/web 共用) ================= */
const runtime = {
  startedAt: Date.now(),
  deps: {}, // { client, ... }
  db: { pointsDb, roomsDb, historyDb, botState },
  app,
  server: null,
};

/** ✅ 把 Discord client / 其他依賴注入 runtime */
function attachRuntime(webRuntime, deps = {}) {
  // 兼容你可能傳進來的 webRuntime / 或直接用同一個 runtime
  const target = webRuntime && typeof webRuntime === "object" ? webRuntime : runtime;

  target.deps = target.deps || {};
  Object.assign(target.deps, deps);

  return target;
}

/* ================= Middleware ================= */
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
app.get("/health", (req, res) => res.json({ ok: true, startedAt: runtime.startedAt }));

/* ================= Login Page ================= */
app.get("/admin/login", (req, res) => {
  const err = req.query?.err;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(loginHtml(Boolean(err)));
});

/* ================= Login Action ================= */
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

/* ================= Logout ================= */
app.get("/admin/logout", (req, res) => {
  res.clearCookie("admin_token", { path: "/" });
  res.redirect("/admin/login");
});

/* ================= Admin UI ================= */
app.get("/admin", auth, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(adminHtml());
});

/* ================= Admin APIs ================= */

/** 讀排行榜 */
app.get("/admin/api/leaderboard", apiAuth, async (req, res) => {
  try {
    const top = Number(req.query?.top || 20);
    const rows = pointsDb?.getLeaderboard ? await pointsDb.getLeaderboard(top) : [];
    return jsonOK(res, { rows });
  } catch {
    return res.status(500).json({ ok: false, error: "LEADERBOARD_FAILED" });
  }
});

/** 讀玩家清單 */
app.get("/admin/api/players", apiAuth, async (req, res) => {
  try {
    const rows = pointsDb?.getAllPlayers ? await pointsDb.getAllPlayers() : [];
    return jsonOK(res, { rows });
  } catch {
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

    if (pointsDb?.adjustPoints) {
      const after = await pointsDb.adjustPoints(userId, d);
      return jsonOK(res, { after });
    }

    return jsonOK(res, { after: null });
  } catch {
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
  } catch {
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
  } catch {
    return res.status(500).json({ ok: false, error: "FORCESTOP_FAILED" });
  }
});

/** 歷史戰績（預設一週內） */
app.get("/admin/api/history", apiAuth, async (req, res) => {
  try {
    const days = Number(req.query?.days || 7);
    const rows = historyDb?.getRecentRooms ? await historyDb.getRecentRooms(days) : [];
    return jsonOK(res, { rows });
  } catch {
    return res.status(500).json({ ok: false, error: "HISTORY_FAILED" });
  }
});

/** 讀設定 */
app.get("/admin/api/settings", apiAuth, async (req, res) => {
  try {
    const settings = roomsDb?.getSettings
      ? await roomsDb.getSettings()
      : botState?.getSettings
      ? botState.getSettings()
      : {};
    return jsonOK(res, { settings });
  } catch {
    return res.status(500).json({ ok: false, error: "SETTINGS_FAILED" });
  }
});

/** 存設定 */
app.post("/admin/api/settings", apiAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    if (roomsDb?.setSettings) {
      await roomsDb.setSettings(payload);
      return jsonOK(res, { saved: true });
    }
    if (botState?.setSettings) {
      botState.setSettings(payload);
      return jsonOK(res, { saved: true });
    }
    return jsonOK(res, { saved: false });
  } catch {
    return res.status(500).json({ ok: false, error: "SETTINGS_SAVE_FAILED" });
  }
});

/* ================= 404 ================= */
app.use((req, res) => res.status(404).send("Not Found"));

/* ================= Start ================= */
function startWeb() {
  const PORT = Number(process.env.PORT || 3000);
  runtime.server = app.listen(PORT, () => console.log(`[Web] listening on ${PORT}`));
  return runtime; // ✅ 這個很重要：index.js / events.js 會用
}

module.exports = { startWeb, attachRuntime, app, runtime };

/* -------------------- HTML -------------------- */
function loginHtml(showErr) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>管理員登入</title>
<style>
body{
  margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
  background:#020617; color:white; font-family:sans-serif;
}
.box{
  width:360px; padding:25px; border-radius:16px;
  background:rgba(255,255,255,.08); backdrop-filter:blur(10px);
}
input,button{
  width:100%; padding:10px; margin:8px 0; border-radius:8px; border:none;
}
button{ background:#38bdf8; font-weight:bold; cursor:pointer; }
.err{ background:#ef4444; padding:6px; border-radius:6px; }
</style>
</head>
<body>
  <form class="box" method="POST" action="/admin/login">
    <h2>管理員登入</h2>
    <input name="user" placeholder="帳號" required />
    <input name="pass" type="password" placeholder="密碼" required />
    <button type="submit">登入</button>
    ${showErr ? `<div class="err">帳密錯誤</div>` : ""}
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
<title>後台</title>
<style>
body{ background:#020617; color:white; font-family:sans-serif; padding:20px; }
.card{ background:rgba(255,255,255,.06); padding:15px; border-radius:12px; margin-bottom:12px; }
a{ color:#38bdf8; }
.mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size:12px; opacity:.8; }
</style>
</head>
<body>
  <h2>管理後台</h2>
  <div class="card">✅ 系統正常</div>
  <div class="card">👤 管理員：<span class="mono">${ADMIN_USER}</span></div>

  <div class="card">
    <div>可用 API：</div>
    <ul>
      <li class="mono">GET /admin/api/leaderboard</li>
      <li class="mono">GET /admin/api/players</li>
      <li class="mono">POST /admin/api/points/adjust</li>
      <li class="mono">GET /admin/api/rooms</li>
      <li class="mono">POST /admin/api/rooms/forceStop</li>
      <li class="mono">GET /admin/api/history</li>
      <li class="mono">GET/POST /admin/api/settings</li>
    </ul>
  </div>

  <a href="/admin/logout">登出</a>
</body>
</html>`;
}
