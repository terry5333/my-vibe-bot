"use strict";

const { getDB } = require("./firebase");

const pointsCache = new Map(); // userId -> points
const leaderboardCache = { updatedAt: 0, top: [] }; // top10

function now() { return Date.now(); }

function bumpTop10(userId, points) {
  const top = leaderboardCache.top.slice();
  const idx = top.findIndex((x) => x.userId === userId);
  if (idx >= 0) top[idx] = { userId, points };
  else top.push({ userId, points });
  top.sort((a, b) => b.points - a.points);
  leaderboardCache.top = top.slice(0, 10);
  leaderboardCache.updatedAt = now();
}

async function refreshTop10() {
  const db = getDB();
  const snap = await db.ref("points").orderByValue().limitToLast(10).get();
  const val = snap.val() || {};
  const arr = Object.entries(val)
    .map(([userId, pts]) => ({ userId, points: Number(pts) || 0 }))
    .sort((a, b) => b.points - a.points);
  leaderboardCache.top = arr;
  leaderboardCache.updatedAt = now();
}

async function getPoints(userId) {
  const cached = pointsCache.get(userId);
  if (typeof cached === "number") return cached;

  const db = getDB();
  const snap = await db.ref(`points/${userId}`).get();
  const pts = Number(snap.val()) || 0;
  pointsCache.set(userId, pts);
  return pts;
}

async function addPoints(userId, amount) {
  const delta = Number(amount);
  if (!userId) throw new Error("addPoints 缺少 userId");
  if (!Number.isFinite(delta) || delta === 0) throw new Error("addPoints amount 無效");

  const db = getDB();
  const ref = db.ref(`points/${userId}`);
  const r = await ref.transaction((cur) => (Number(cur) || 0) + delta);
  if (!r.committed) throw new Error("addPoints 寫入未成功");

  const newPts = Number(r.snapshot.val()) || 0;
  pointsCache.set(userId, newPts);
  bumpTop10(userId, newPts);
  return newPts;
}

function getTop10Cache() {
  return { ...leaderboardCache, top: leaderboardCache.top.slice() };
}

async function getLeaderboard(limit = 100) {
  const db = getDB();
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const snap = await db.ref("points").orderByValue().limitToLast(n).get();
  const val = snap.val() || {};
  return Object.entries(val)
    .map(([userId, pts]) => ({ userId, points: Number(pts) || 0 }))
    .sort((a, b) => b.points - a.points);
}

function startPointsListeners() {
  const db = getDB();
  db.ref("points").on("child_added", (snap) => {
    const uid = snap.key;
    const pts = Number(snap.val()) || 0;
    pointsCache.set(uid, pts);
    bumpTop10(uid, pts);
  });
  db.ref("points").on("child_changed", (snap) => {
    const uid = snap.key;
    const pts = Number(snap.val()) || 0;
    pointsCache.set(uid, pts);
    bumpTop10(uid, pts);
  });

  setInterval(() => refreshTop10().catch(() => {}), 20_000);
}

module.exports = {
  addPoints,
  getPoints,
  getTop10Cache,
  getLeaderboard,
  startPointsListeners,
};
