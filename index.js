"use strict";

/**
 * 必開 Intents：
 * MESSAGE CONTENT INTENT
 */

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const {
  Client,
  GatewayIntentBits,
} = require("discord.js");

/* ======================
   ENV
====================== */
const {
  DISCORD_TOKEN,
  JWT_SECRET,
  ADMIN_USER,
  ADMIN_PASS,
} = process.env;

if (!DISCORD_TOKEN || !JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.error("❌ 缺少必要 ENV");
  process.exit(1);
}

/* ======================
   Express
====================== */
const app = express();

// 👉 Railway/Render 必加
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Web Server OK:", PORT);
});

app.get("/", (_, res) => res.send("OK"));

/* ======================
   JWT 驗證
====================== */
function auth(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.redirect("/admin/login");

  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.redirect("/admin/login");
  }
}

/* ======================
   Login Page
====================== */
app.get("/admin/login", (req, res) => {
  const err = req.query.err;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  res.end(`
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>管理後台登入</title>

<style>
body{
  margin:0;
  height:100vh;
  display:flex;
  justify-content:center;
  align-items:center;
  background:linear-gradient(135deg,#0f172a,#020617);
  font-family:sans-serif;
  color:#fff;
}

.box{
  width:360px;
  padding:30px;
  border-radius:20px;
  background:rgba(255,255,255,.08);
  backdrop-filter:blur(15px);
  border:1px solid rgba(255,255,255,.15);
}

h1{text-align:center}

input{
  width:100%;
  padding:12px;
  margin:10px 0;
  border-radius:10px;
  border:none;
}

button{
  width:100%;
  padding:12px;
  border:none;
  border-radius:10px;
  background:#38bdf8;
  font-weight:bold;
  cursor:pointer;
}

.err{
  background:#ef4444;
  padding:8px;
  border-radius:8px;
  margin-top:10px;
}
</style>
</head>

<body>

<form class="box" method="POST" action="/admin/login">

<h1>管理員登入</h1>

<input name="user" placeholder="帳號" required />
<input name="pass" type="password" placeholder="密碼" required />

<button>登入</button>

${err ? `<div class="err">帳密錯誤</div>` : ""}

</form>

</body>
</html>
`);
});

/* ======================
   Login API
====================== */
app.post("/admin/login", (req, res) => {

  const { user, pass } = req.body;

  if (user === ADMIN_USER && pass === ADMIN_PASS) {

    const token = jwt.sign({ user }, JWT_SECRET, {
      expiresIn: "12h",
    });

    // 👉 Railway HTTPS 修正
    const isHttps =
      req.secure ||
      req.headers["x-forwarded-proto"] === "https";

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

/* ======================
   Logout
====================== */
app.get("/admin/logout", (_, res) => {
  res.clearCookie("admin_token");
  res.redirect("/admin/login");
});

/* ======================
   Admin Page
====================== */
app.get("/admin", auth, (req, res) => {

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  res.end(`
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>後台</title>

<style>
body{
  margin:0;
  background:#020617;
  color:white;
  font-family:sans-serif;
  padding:20px;
}

.top{
  display:flex;
  justify-content:space-between;
  margin-bottom:20px;
}

.card{
  background:rgba(255,255,255,.06);
  padding:15px;
  border-radius:15px;
  margin-bottom:15px;
}

input,button{
  padding:8px;
  border-radius:8px;
  border:none;
}

button{
  background:#38bdf8;
  font-weight:bold;
}
</style>
</head>

<body>

<div class="top">
  <h2>管理後台</h2>
  <a href="/admin/logout" style="color:#38bdf8">登出</a>
</div>

<div class="card">

<h3>系統狀態</h3>

<p>Discord Bot：運作中</p>
<p>登入身分：${ADMIN_USER}</p>

</div>

<div class="card">

<h3>之後可以放：</h3>

<ul>
<li>積分管理</li>
<li>遊戲房間</li>
<li>排行榜</li>
<li>設定頁</li>
</ul>

</div>

</body>
</html>
`);
});

/* ======================
   Discord Bot
====================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", () => {
  console.log("Bot Online:", client.user.tag);
});

client.login(DISCORD_TOKEN);
