"use strict";

const { getDB } = require("./firebase");

/** 讀取玩家積分 */
async function getPoints(userId) {
  const db = getDB();
  const snap = await db.ref(`points/${userId}`).get();
  return Number(snap.val() ?? 0);
}

/** 設定玩家積分 */
async function setPoints(userId, value) {
  const db = getDB();
  const v = Number(value) || 0;
  await db.ref(`points/${userId}`).set(v);
  return v;
}

/**
 * ✅ 全域加分函數（transaction 防打架）
 */
async function addPoints(userId, amount) {
  const db = getDB();
  const delta = Number(amount) || 0;

  const ref = db.ref(`points/${userId}`);
  const result = await ref.transaction((cur) => {
    const curNum = Number(cur ?? 0);
    return curNum + delta;
  });

  if (!result.committed) throw new Error("transaction not committed");
  return Number(result.snapshot.val() ?? 0);
}

/* =========================
   ✅ 後台需要的相容 API
   ========================= */

/** 後台：調整積分（delta） */
async function adjustPoints(userId, delta) {
  return addPoints(userId, delta);
}

/** 後台：列出所有玩家（從 points 節點掃出來） */
async function getAllPlayers() {
  const db = getDB();
  const snap = await db.ref("points").get();
  const obj = snap.val() || {};

  // 回傳格式：[{ userId, points }]
  return Object.entries(obj).map(([userId, points]) => ({
    userId,
    points: Number(points ?? 0),
  }));
}

/** 後台：排行榜 */
async function getLeaderboard(top = 20) {
  const rows = await getAllPlayers();
  rows.sort((a, b) => b.points - a.points);
  return rows.slice(0, Math.max(1, Number(top) || 20));
}

module.exports = {
  getPoints,
  setPoints,
  addPoints,

  // ✅ 後台用
  adjustPoints,
  getAllPlayers,
  getLeaderboard,
};
