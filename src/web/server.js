"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const app = express();

const {
  JWT_SECRET,
  ADMIN_USER,
  ADMIN_PASS,
} = process.env;

if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.error("❌ 缺少 ENV (JWT_SECRET / ADMIN_USER / ADMIN_PASS)");
}

/* ================= Middleware ================= */

app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* ================= Root ================= */

app.get("/", (req, res) => {
  res.send("OK");
});

/* ================= Auth ================= */

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

/* ================= Login Page ================= */

app.get("/admin/login", (req, res) => {
  const err = req.query.err;

  res.setHeader("Content-Type", "text/html; charset=utf-8");

  res.end(`
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<title>管理登入</title>

<style>
body{
  margin:0;
  height:100vh;
  display:flex;
  justify-content:center;
  align-items:center;
  background:#020617;
  font-family:sans-serif;
  color:white;
}

.box{
  width:360px;
  padding:25px;
  border-radius:16px;
  background:rgba(255,255,255,.08);
  backdrop-filter:blur(10px);
}

input,button{
  width:100%;
  padding:10px;
  margin:8px 0;
  border-radius:8px;
  border:none;
}

button{
  background:#38bdf8;
  font-weight:bold;
}

.err{
  background:#ef4444;
  padding:6px;
  border-radius:6px;
}
</style>
</head>

<body>

<form class="box" method="POST" action="/admin/login">

<h2>管理員登入</h2>

<input name="user" placeholder="帳號" required>
<input name="pass" type="password" placeholder="密碼" required>

<button>登入</button>

${err ? `<div class="err">帳密錯誤</div>` : ""}

</form>

</body>
</html>
`);
});

/* ================= Login API ================= */

app.post("/admin/login", (req, res) => {
  const { user, pass } = req.body;

  if (user === ADMIN_USER && pass === ADMIN_PASS) {

    const token = jwt.sign({ user }, JWT_SECRET, {
      expiresIn: "12h",
    });

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

/* ================= Admin ================= */

app.get("/admin", auth, (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  res.end(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>後台</title>

<style>
body{
  background:#020617;
  color:white;
  font-family:sans-serif;
  padding:20px;
}

.card{
  background:rgba(255,255,255,.06);
  padding:15px;
  border-radius:12px;
  margin-bottom:12px;
}
</style>
</head>

<body>

<h2>管理後台</h2>

<div class="card">✅ 系統正常</div>
<div class="card">👤 管理員：${ADMIN_USER}</div>

<a href="/admin/logout" style="color:#38bdf8">登出</a>

</body>
</html>
`);
});

/* ================= Logout ================= */

app.get("/admin/logout", (req, res) => {
  res.clearCookie("admin_token");
  res.redirect("/admin/login");
});

/* ================= Start ================= */

function startWeb() {
  const PORT = process.env.PORT || 3000;

  app.listen(PORT, () => {
    console.log("[Web] listening on", PORT);
  });
}

module.exports = { startWeb };
