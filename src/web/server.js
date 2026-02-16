"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const { getDB } = require("../db/firebase");
const { addPoints } = require("../db/points");

const app = express();

const { JWT_SECRET, ADMIN_USER, ADMIN_PASS } = process.env;
if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.error("❌ 缺少 ENV：JWT_SECRET / ADMIN_USER / ADMIN_PASS");
}

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/** runtime：讓 web 看到目前 rooms（不靠DB） */
function createRuntime() {
  return {
    rooms: new Map(), // key: channelId 或 hl:userId
    ctx: { client: null },
  };
}
let _runtime = createRuntime();

/** 給 index.js 注入 client */
function attachRuntime(runtime, ctx) {
  runtime.ctx = ctx;
  _runtime = runtime;
}

app.get("/", (req, res) => res.send("OK"));

function auth(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.redirect("/admin/login");
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.redirect("/admin/login");
  }
}
function authApi(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
}

/* ===== Login ===== */
app.get("/admin/login", (req, res) => {
  const err = req.query.err;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>管理員登入</title>
<style>
:root{
  --bg1:#060b1a; --bg2:#0b1333;
  --glass:rgba(255,255,255,.08);
  --line:rgba(255,255,255,.14);
  --txt:rgba(255,255,255,.92);
  --muted:rgba(255,255,255,.62);
  --brand:#7c3aed; --brand2:#22d3ee;
}
*{box-sizing:border-box}
body{
  margin:0; min-height:100vh; display:grid; place-items:center;
  background: radial-gradient(1200px 600px at 20% 10%, rgba(124,58,237,.25), transparent 60%),
              radial-gradient(900px 600px at 90% 30%, rgba(34,211,238,.18), transparent 60%),
              linear-gradient(180deg, var(--bg1), var(--bg2));
  font-family: ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC";
  color:var(--txt);
}
.card{
  width:min(420px, 92vw);
  padding:22px;
  border-radius:18px;
  background:var(--glass);
  border:1px solid var(--line);
  backdrop-filter: blur(14px);
  box-shadow: 0 20px 60px rgba(0,0,0,.35);
}
.title{font-size:20px; font-weight:900; margin:0 0 10px}
.sub{margin:0 0 18px; color:var(--muted); font-size:13px}
label{display:block; font-size:12px; color:var(--muted); margin:12px 0 6px}
input{
  width:100%; padding:12px 12px;
  border-radius:12px;
  border:1px solid rgba(255,255,255,.14);
  background: rgba(255,255,255,.06);
  color:var(--txt);
  outline:none;
}
.btn{
  margin-top:14px; width:100%; padding:12px 14px;
  border-radius:12px; border:0; cursor:pointer;
  color:white; font-weight:900;
  background: linear-gradient(90deg, var(--brand), var(--brand2));
}
.err{
  margin-top:12px;
  padding:10px 12px;
  border-radius:12px;
  background: rgba(239,68,68,.16);
  border:1px solid rgba(239,68,68,.35);
  color:#fecaca;
  font-size:13px;
}
</style>
</head>
<body>
  <form class="card" method="POST" action="/admin/login">
    <h1 class="title">管理員登入</h1>
    <p class="sub">登入後可管理玩家積分、排行榜、遊戲房間</p>

    <label>帳號</label>
    <input name="user" autocomplete="username" required />

    <label>密碼</label>
    <input name="pass" type="password" autocomplete="current-password" required />

    <button class="btn">登入</button>
    ${err ? `<div class="err">帳號或密碼錯誤</div>` : ``}
  </form>
</body>
</html>`);
});

app.post("/admin/login", (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = jwt.sign({ user }, JWT_SECRET, { expiresIn: "12h" });

    const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: isHttps,
      sameSite: "lax",
      maxAge: 12 * 60 * 60 * 1000,
    });
    return res.redirect("/admin");
  }
  res.redirect("/admin/login?err=1");
});

app.get("/admin/logout", (req, res) => {
  res.clearCookie("admin_token");
  res.redirect("/admin/login");
});

/* ===== Admin UI ===== */
app.get("/admin", auth, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>管理後台</title>
<style>
:root{
  --bg1:#060b1a; --bg2:#0b1333;
  --glass:rgba(255,255,255,.08);
  --line:rgba(255,255,255,.14);
  --txt:rgba(255,255,255,.92);
  --muted:rgba(255,255,255,.62);
  --brand:#7c3aed; --brand2:#22d3ee;
}
*{box-sizing:border-box}
body{
  margin:0; min-height:100vh;
  background: radial-gradient(1200px 600px at 20% 10%, rgba(124,58,237,.22), transparent 60%),
              radial-gradient(900px 600px at 90% 30%, rgba(34,211,238,.18), transparent 60%),
              linear-gradient(180deg, var(--bg1), var(--bg2));
  font-family: ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC";
  color:var(--txt);
}
.layout{display:grid; grid-template-columns: 280px 1fr; min-height:100vh}
.sidebar{
  padding:18px;
  border-right:1px solid rgba(255,255,255,.08);
  background: rgba(255,255,255,.04);
  backdrop-filter: blur(14px);
}
.brand{
  display:flex; align-items:center; gap:10px;
  padding:12px; border-radius:16px;
  background: var(--glass);
  border: 1px solid var(--line);
}
.dot{
  width:12px; height:12px; border-radius:50%;
  background: linear-gradient(90deg, var(--brand), var(--brand2));
}
.menu{margin-top:14px; display:grid; gap:8px}
.btn{
  display:flex; align-items:center; gap:10px;
  padding:12px;
  border-radius:14px;
  border:1px solid rgba(255,255,255,.10);
  background: rgba(255,255,255,.06);
  color:var(--txt);
  cursor:pointer;
}
.btn.active{border-color: rgba(34,211,238,.35); background: rgba(34,211,238,.08)}
.main{padding:22px}
.title{font-size:22px; font-weight:900; margin:0 0 12px}
.card{
  padding:14px;
  border-radius:18px;
  background: var(--glass);
  border:1px solid var(--line);
  backdrop-filter: blur(14px);
}
.row{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
.input{
  padding:10px 12px;
  border-radius:12px;
  border:1px solid rgba(255,255,255,.14);
  background: rgba(255,255,255,.06);
  color:var(--txt);
  outline:none;
}
.tag{
  padding:8px 10px; border-radius:999px;
  background: rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.10);
  color:var(--muted);
  font-size:12px;
}
table{width:100%; border-collapse:separate; border-spacing:0 10px}
thead th{color:var(--muted); font-size:12px; text-align:left; font-weight:700; padding:0 10px}
tbody td{padding:12px 10px; vertical-align:middle; background:rgba(255,255,255,.06)}
.avatar{width:34px; height:34px; border-radius:12px; object-fit:cover; border:1px solid rgba(255,255,255,.12)}
.name{font-weight:900}
.muted{color:var(--muted); font-size:12px}
.sbtn{
  padding:9px 10px; border-radius:12px; border:1px solid rgba(255,255,255,.12);
  background: rgba(255,255,255,.06); color:var(--txt); cursor:pointer;
  min-width:44px;
}
.toast{
  position:fixed; right:18px; bottom:18px;
  padding:10px 12px;
  border-radius:14px;
  background: rgba(0,0,0,.55);
  border:1px solid rgba(255,255,255,.12);
  color:white; font-size:13px;
  opacity:0; transform:translateY(8px);
  transition:.2s; pointer-events:none;
}
.toast.show{opacity:1; transform:none}
a{color:rgba(34,211,238,.9)}
@media (max-width: 960px){
  .layout{grid-template-columns: 1fr}
  .sidebar{position:sticky; top:0; z-index:10}
}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="brand">
      <span class="dot"></span>
      <div>
        <div style="font-weight:900">管理後台</div>
        <div class="muted">my-vibe-bot</div>
      </div>
    </div>

    <div class="menu">
      <button class="btn active" data-tab="rank">📊 排行榜</button>
      <button class="btn" data-tab="players">👤 玩家積分管理</button>
      <button class="btn" data-tab="rooms">🎮 房間管理</button>
      <button class="btn" data-tab="history">🕒 一週歷史戰績</button>
    </div>

    <div style="margin-top:14px" class="muted">登入：${ADMIN_USER}</div>
    <div style="margin-top:8px"><a href="/admin/logout">登出</a></div>
  </aside>

  <main class="main">
    <h1 class="title" id="pageTitle">排行榜</h1>

    <section id="tab-rank" class="card">
      <div class="row" style="justify-content:space-between">
        <div class="tag">Top 50</div>
        <button class="sbtn" id="rankReload">重新整理</button>
      </div>
      <div style="height:10px"></div>
      <div id="rankBox" class="muted">載入中…</div>
    </section>

    <section id="tab-players" class="card" style="display:none; margin-top:12px">
      <div class="row" style="justify-content:space-between">
        <div class="row">
          <input id="playerSearch" class="input" placeholder="搜尋：名字 / ID" />
          <button class="sbtn" id="playerReload">重新整理</button>
        </div>
        <div class="tag">可直接 + / - 改分</div>
      </div>

      <div style="height:10px"></div>

      <table>
        <thead>
          <tr>
            <th>玩家</th>
            <th>ID</th>
            <th>積分</th>
            <th style="text-align:right">操作</th>
          </tr>
        </thead>
        <tbody id="playersTbody">
          <tr><td colspan="4" class="muted">載入中…</td></tr>
        </tbody>
      </table>
    </section>

    <section id="tab-rooms" class="card" style="display:none; margin-top:12px">
      <div class="row" style="justify-content:space-between">
        <div class="tag">目前進行中的房間</div>
        <button class="sbtn" id="roomsReload">重新整理<
