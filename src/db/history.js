"use strict";

const admin = require("firebase-admin");

/**
 * Firebase RTDB 結構建議：
 * /history/{roomId}/{recordId} = { roomId, game, winnerId, startedAt, endedAt, createdAt, ... }
 */

function db() {
  return admin.database();
}

async function addHistory(roomId, record = {}) {
  if (!roomId) throw new Error("roomId required");
  const ref = db().ref(`history/${roomId}`).push();
  const payload = { ...record, roomId, createdAt: Date.now() };
  await ref.set(payload);
  return { id: ref.key, ...payload };
}

/**
 * 取最近 N 天（預設給後台用）
 * 注意：RTDB 不是資料庫索引，這裡用 createdAt 做篩選（讀出後在程式端 filter）
 */
async function getRecentRooms(days = 7) {
  const since = Date.now() - Number(days || 7) * 24 * 60 * 60 * 1000;
  const snap = await db().ref("history").once("value");
  const root = snap.val() || {};

  const rows = [];
  for (const roomId of Object.keys(root)) {
    const items = root[roomId] || {};
    for (const key of Object.keys(items)) {
      const rec = items[key];
      if ((rec?.createdAt || 0) >= since) rows.push({ id: key, ...rec });
    }
  }

  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

module.exports = {
  addHistory,
  getRecentRooms,
};
