"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");

const { auth, authApi, isHttpsReq } = require("./auth");
const api = require("./api");

function startWeb() {
  const app = express();

  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.get("/", (_req, res) => res.status(200).send("OK"));

  // ---- pages ----
  app.get("/admin/login", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "login.html"));
  });

  app.post("/admin/login", (req, res) => {
    const { user, pass } = req.body || {};
    if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
      const token = jwt.sign({ user }, process.env.JWT_SECRET, { expiresIn: "12h" });
      res.cookie("admin_token", token, {
        httpOnly: true,
        secure: isHttpsReq(req),
        sameSite: "lax",
        maxAge: 12 * 60 * 60 * 1000,
      });
      return res.redirect("/admin");
    }
    return res.redirect("/admin/login?err=1");
  });

  app.get("/admin/logout", (_req, res) => {
    res.clearCookie("admin_token");
    res.redirect("/admin/login");
  });

  app.get("/admin", auth, (_req, res) => {
    res.sendFile(path.join(__dirname, "views", "admin.html"));
  });

  // ---- API (auth) ----
  app.get("/api/leaderboard", authApi, api.apiLeaderboard);
  app.get("/api/users", authApi, api.apiUsers);
  app.post("/api/points/adjust", authApi, api.apiAdjustPoints);

  app.get("/api/rooms", authApi, api.apiRooms);
  app.post("/api/rooms/force-stop", authApi, api.apiForceStop);

  app.get("/api/history/days", authApi, api.apiHistoryDays);
  app.get("/api/history/:day/rooms", authApi, api.apiHistoryRooms);
  app.get("/api/history/:day/:roomId/events", authApi, api.apiHistoryEvents);

  app.get("/api/settings", authApi, api.apiGetSettings);
  app.post("/api/settings", authApi, api.apiSaveSettings);
  app.post("/api/weekly/payout", authApi, api.apiWeeklyPayout);
  app.post("/api/weekly/reset", authApi, api.apiWeeklyReset);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log("[Web] listening on", PORT));
}

module.exports = { startWeb };
