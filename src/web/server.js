"use strict";

const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

/* -------------------- Safe require -------------------- */
function safeRequire(p) {
  try {
    return require(p);
  } catch (e) {
    console.warn(`[Web] ⚠️ 找不到模組：${p}（先用空功能代替）`);
    return null;
  }
}

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
app.get("/health", (req, res) => res.json({ ok: true }));

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

app.get("/admin/api/leaderboard", apiAuth, async (req, res) => {
  try {
    const top = Number(req.query?.top || 20);
    const rows = pointsDb?.getLeaderboard ? await pointsDb.getLeaderboard(top) : [];
    return jsonOK(res, { rows });
  } catch (e) {
    console.error("[Web] leaderboard error:", e);
    return res.status(500).json({ ok: false, error: "LEADERBOARD_FAILED" });
  }
});

app.get("/admin/api/players", apiAuth, async (req, res) => {
  try {
    const rows = pointsDb?.getAllPlayers ? await pointsDb.getAllPlayers() : [];
    return jsonOK(res, { rows });
  } catch (e) {
    console.error("[Web] players error:", e);
    return res.status(500).json({ ok: false, error: "PLAYERS_FAILED" });
  }
});

app.post("/admin/api/points/adjust", apiAuth, async (req, res) => {
  try {
    const { userId, delta } = req.body || {};
    const d = Number(delta || 0);
    if (!userId || !Number.isFinite(d)) {
      return res.status(400).json({ ok: false, error: "BAD_REQUEST" });
    }

    if (pointsDb?.addPoints) {
      const after = await pointsDb.addPoints(userId, d);
      return jsonOK(res, { after });
    }

    return jsonOK(res, { after: null });
  } catch (e) {
    console.error("[Web] adjust error:", e);
    return res.status(500).json({ ok: false, error: "ADJUST_FAILED" });
  }
});

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

app.get("/admin/api/history", apiAuth, async (req, res) => {
  try {
    const days = Number(req.query?.days || 7);
    const rows = historyDb?.getRecentRooms ? await historyDb.getRecentRooms(days) : [];
    return jsonOK(res, { rows });
  } catch (e) {
    console.error("[Web] history error:", e);
    return res.status(500).json({ ok: false, error: "HISTORY_FAILED" });
  }
});

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
  return { app };
}

module.exports = { startWeb, app };

/* -------------------- HTML -------------------- */
function loginHtml(showErr) {
  return `<!DOCTYPE html>
<html lang="zh-TW"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>管理員登入</title>
<style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#020617;color:#fff;font-family:sans-serif;}
.box{width:360px;padding:25px;border-radius:16px;background:rgba(255,255,255,.08);backdrop-filter:blur(10px);}
input,button{width:100%;padding:10px;margin:8px 0;border-radius:8px;border:none;}
button{background:#38bdf8;font-weight:bold;cursor:pointer;}
.err{background:#ef4444;padding:6px;border-radius:6px;}
</style>
</head><body>
<form class="box" method="POST" action="/admin/login">
<h2>管理員登入</h2>
<input name="user" placeholder="帳號" required />
<input name="pass" type="password" placeholder="密碼" required />
<button type="submit">登入</button>
${showErr ? `<div class="err">帳密錯誤</div>` : ""}
</form>
</body></html>`;
}

function adminHtml() {
  return `<!DOCTYPE html>
<html lang="zh-TW"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>後台</title>
<style>
body{background:#020617;color:white;font-family:sans-serif;padding:20px;}
.card{background:rgba(255,255,255,.06);padding:15px;border-radius:12px;margin-bottom:12px;}
a{color:#38bdf8;}
table{width:100%;border-collapse:collapse;font-size:14px;}
th,td{border-bottom:1px solid rgba(255,255,255,.12);padding:8px;text-align:left;vertical-align:top;}
input,button,select{padding:8px;border-radius:8px;border:none;}
button{background:#38bdf8;font-weight:bold;cursor:pointer;}
.small{font-size:12px;opacity:.8;}
.mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;}
.row{display:flex;gap:12px;flex-wrap:wrap;}
.row>.card{flex:1;min-width:320px;}
</style>
</head>
<body>
<h2>管理後台</h2>
<div class="card">👤 管理員： <span class="mono">${ADMIN_USER}</span>　｜　<a href="/admin/logout">登出</a></div>

<div class="row">
  <div class="card">
    <h3>排行榜</h3>
    <button onclick="loadLeaderboard()">重新載入</button>
    <div id="lb" class="small mono">載入中...</div>
  </div>

  <div class="card">
    <h3>玩家 / 調分</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
      <input id="uid" placeholder="userId" style="flex:1;min-width:220px;">
      <input id="delta" placeholder="delta (例如 10 或 -5)" style="width:180px;">
      <button onclick="adjust()">送出</button>
    </div>
    <button onclick="loadPlayers()">重新載入玩家</button>
    <div id="players" class="small mono">載入中...</div>
  </div>
</div>

<div class="row">
  <div class="card">
    <h3>房間狀態</h3>
    <button onclick="loadRooms()">重新載入</button>
    <div id="rooms" class="small mono">載入中...</div>
  </div>

  <div class="card">
    <h3>歷史紀錄</h3>
    <button onclick="loadHistory()">重新載入</button>
    <div id="history" class="small mono">載入中...</div>
  </div>
</div>

<div class="card">
  <h3>Settings</h3>
  <div class="small">guildId（預設 global）：</div>
  <input id="gid" value="global" style="width:220px" />
  <button onclick="loadSettings()">讀取</button>
  <button onclick="saveSettings()">儲存</button>
  <div class="small">JSON：</div>
  <textarea id="settings" style="width:100%;height:160px;border-radius:12px;padding:10px;border:none;"></textarea>
</div>

<script>
async function api(url, opts){
  const res = await fetch(url, {headers: {'Content-Type':'application/json'}, ...opts});
  const json = await res.json().catch(()=>null);
  if(!res.ok || !json || json.ok === false){
    throw new Error((json && json.error) || ('HTTP_'+res.status));
  }
  return json;
}

function toTable(rows, cols){
  if(!rows || !rows.length) return '<div class="small">（沒有資料）</div>';
  let h = '<table><thead><tr>' + cols.map(c=>'<th>'+c+'</th>').join('') + '</tr></thead><tbody>';
  h += rows.map(r=>{
    return '<tr>' + cols.map(c=>{
      const v = r[c];
      return '<td class="mono">'+(v===undefined?'':String(v))+'</td>';
    }).join('') + '</tr>';
  }).join('');
  h += '</tbody></table>';
  return h;
}

async function loadLeaderboard(){
  const el = document.getElementById('lb');
  el.textContent = '載入中...';
  try{
    const j = await api('/admin/api/leaderboard?top=20');
    el.innerHTML = toTable(j.rows, ['userId','points']);
  }catch(e){
    el.textContent = '載入失敗：' + e.message;
  }
}

async function loadPlayers(){
  const el = document.getElementById('players');
  el.textContent = '載入中...';
  try{
    const j = await api('/admin/api/players');
    el.innerHTML = toTable(j.rows, ['userId','points']);
  }catch(e){
    el.textContent = '載入失敗：' + e.message;
  }
}

async function adjust(){
  const uid = document.getElementById('uid').value.trim();
  const delta = document.getElementById('delta').value.trim();
  if(!uid) return alert('請填 userId');
  try{
    const j = await api('/admin/api/points/adjust', {method:'POST', body: JSON.stringify({userId: uid, delta})});
    alert('完成！最新分數：' + j.after);
    loadLeaderboard();
    loadPlayers();
  }catch(e){
    alert('失敗：' + e.message);
  }
}

async function loadRooms(){
  const el = document.getElementById('rooms');
  el.textContent = '載入中...';
  try{
    const j = await api('/admin/api/rooms');
    el.innerHTML = toTable(j.rooms, ['roomId','status','game','updatedAt','stoppedAt']);
  }catch(e){
    el.textContent = '載入失敗：' + e.message;
  }
}

async function loadHistory(){
  const el = document.getElementById('history');
  el.textContent = '載入中...';
  try{
    const j = await api('/admin/api/history?days=7');
    el.innerHTML = toTable(j.rows, ['id','roomId','game','winner','createdAt']);
  }catch(e){
    el.textContent = '載入失敗：' + e.message;
  }
}

async function loadSettings(){
  const gid = document.getElementById('gid').value.trim() || 'global';
  const el = document.getElementById('settings');
  el.value = '';
  try{
    const j = await api('/admin/api/settings?guildId=' + encodeURIComponent(gid));
    el.value = JSON.stringify(j.settings || {}, null, 2);
  }catch(e){
    el.value = '讀取失敗：' + e.message;
  }
}

async function saveSettings(){
  const gid = document.getElementById('gid').value.trim() || 'global';
  const el = document.getElementById('settings');
  let obj = {};
  try{
    obj = JSON.parse(el.value || '{}');
  }catch{
    return alert('JSON 格式錯誤，不能儲存');
  }
  try{
    await api('/admin/api/settings?guildId=' + encodeURIComponent(gid), {method:'POST', body: JSON.stringify(obj)});
    alert('已儲存');
  }catch(e){
    alert('儲存失敗：' + e.message);
  }
}

loadLeaderboard();
loadPlayers();
loadRooms();
loadHistory();
loadSettings();
</script>

</body></html>`;
}