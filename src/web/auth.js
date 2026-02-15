"use strict";

const jwt = require("jsonwebtoken");

function isHttpsReq(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function auth(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.redirect("/admin/login");
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.redirect("/admin/login");
  }
}

function authApi(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
}

module.exports = { auth, authApi, isHttpsReq };
