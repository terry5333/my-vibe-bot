"use strict";

const { getDB } = require("../db/firebase");
const { addPoints, getLeaderboard } = require("../db/points");
const {
  getActiveRoomsAll,
  listHistoryDays,
  listHistoryRoomsByDay,
  getHistoryRoomEvents,
} = require("../db/logs");
const { getClient } = require("../bot/client");
const {
  getLiveRoomsSnapshot,
  forceStopGuess,
  forceStopCounting,
  forceStopHL,
  getConfig,
  payoutWeeklyTop,
} = require("../bot/games");

function safeNum(n, def = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : def;
}

async function apiLeaderboard(req, res) {
  const limit = Math.max(1, Math.min(200, safeNum(req.query.limit, 100)));
  const data = await getLeaderboard(limit);
  res.json({ ok: true, data });
}

async function apiUsers(req, res) {
  const db = getDB();
  const q = String(req.query.q || "").trim().toLowerCase();

  const snap = await db.ref("users").limitToLast(300).get();
  const users = snap.val() || {};

  const pointsSnap = await db.ref("points").limitToLast(300).get();
  const points = pointsSnap.val() || {};

  const arr = Object.entries(users).map(([userId, u]) => ({
    userId,
    name: u.name || "",
    avatar: u.avatar || "",
    points: Number(points[userId]) || 0,
    updatedAt: Number(u.updatedAt) || 0,
  }));

  const filtered = q
    ? arr.filter((x) => x.userId.includes(q) || String(x.name).toLowerCase().includes(q))
    : arr;

  filtered.sort((a, b) => b.points - a.points);
  res.json({ ok: true, data: filtered.slice(0, 200) });
}

async function apiAdjustPoints(req, res) {
  const userId = String(req.body.userId || "").trim();
  const amount = safeNum(req.body.amount, 0);
  if (!userId || !amount) return res.status(400).json({ ok: false, error: "BAD_REQUEST" });

  const newPts = await addPoints(userId, amount);
  res.json({ ok: true, userId, newPoints: newPts });
}

async function apiRooms(req, res) {
  // live memory + db active snapshot
  const live = getLiveRoomsSnapshot();
  const activeDb = await getActiveRoomsAll();
  res.json({ ok: true, live, activeDb });
}

async function apiForceStop(req, res) {
  const type = String(req.body.type || "");
  const guildId = String(req.body.guildId || "");
  const channelId = String(req.body.channelId || "");
  const userId = String(req.body.userId || "");

  if (type === "guess" && guildId && channelId) {
    await forceStopGuess(guildId, channelId);
    return res.json({ ok: true });
  }
  if (type === "counting" && guildId && channelId) {
    await forceStopCounting(guildId, channelId);
    return res.json({ ok: true });
  }
  if (type === "hl" && guildId && userId) {
    await forceStopHL(guildId, userId);
    return res.json({ ok: true });
  }

  res.status(400).json({ ok: false, error: "BAD_REQUEST" });
}

async function apiHistoryDays(req, res) {
  const days = Math.max(1, Math.min(14, safeNum(req.query.days, 7)));
  const data = await listHistoryDays(days);
  res.json({ ok: true, data });
}

async function apiHistoryRooms(req, res) {
  const dk = String(req.params.day || "");
  const data = await listHistoryRoomsByDay(dk);
  res.json({ ok: true, data });
}

async function apiHistoryEvents(req, res) {
  const dk = String(req.params.day || "");
  const roomId = String(req.params.roomId || "");
  const limit = Math.max(10, Math.min(500, safeNum(req.query.limit, 200)));
  const data = await getHistoryRoomEvents(dk, roomId, limit);
  res.json({ ok: true, data });
}

async function apiGetSettings(req, res) {
  res.json({ ok: true, data: getConfig() });
}

async function apiSaveSettings(req, res) {
  const db = getDB();
  const section = String(req.body.section || "");

  if (section === "vip") {
    const enabled = !!req.body.enabled;
    const guildId = String(req.body.guildId || "").trim();
    const roleId = String(req.body.roleId || "").trim();
    const threshold = Math.max(1, safeNum(req.body.threshold, 1000));
    await db.ref("config/vip").set({ enabled, guildId, roleId, threshold });
    return res.json({ ok: true });
  }

  if (section === "weekly") {
    const enabled = !!req.body.enabled;
    const topN = Math.max(1, safeNum(req.body.topN, 3));
    const reward = Math.max(1, safeNum(req.body.reward, 100));
    await db.ref("config/weekly").set({ enabled, topN, reward });
    return res.json({ ok: true });
  }

  res.status(400).json({ ok: false, error: "BAD_REQUEST" });
}

async function apiWeeklyPayout(req, res) {
  const client = getClient();
  const out = await payoutWeeklyTop(client);
  res.json(out);
}

async function apiWeeklyReset(req, res) {
  const db = getDB();
  // reset current week lock
  const d = new Date();
  const y = d.getUTCFullYear();
  // reuse from game module not exposed; do simplest: remove all locks is dangerous
  // so only remove latest lock key based on stored weeklyLocks keys (safe enough)
  const snap = await db.ref("weeklyLocks").get();
  const locks = snap.val() || {};
  const keys = Object.keys(locks).sort().reverse();
  if (keys[0]) await db.ref(`weeklyLocks/${keys[0]}`).remove();
  res.json({ ok: true, removed: keys[0] || null });
}

module.exports = {
  apiLeaderboard,
  apiUsers,
  apiAdjustPoints,
  apiRooms,
  apiForceStop,
  apiHistoryDays,
  apiHistoryRooms,
  apiHistoryEvents,
  apiGetSettings,
  apiSaveSettings,
  apiWeeklyPayout,
  apiWeeklyReset,
};
