"use strict";

const { getDB } = require("./firebase");

/**
 * history 結構建議：
 * history/{autoId} = { roomId, game, winner, detail, createdAt }
 */

async function addHistory(row) {
  const db = getDB();
  const ref = db.ref("history").push();
  const payload = {
    ...(row || {}),
    createdAt: Date.now(),
  };
  await ref.set(payload);
  return { id: ref.key, ...payload };
}

/** 取最近 N 天資料 */
async function getRecentRooms(days = 7) {
  const db = getDB();
  const since = Date.now() - Number(days || 7) * 24 * 60 * 60 * 1000;

  const snap = await db.ref("history").orderByChild("createdAt").startAt(since).get();
  const val = snap.val() || {};
  const rows = Object.entries(val).map(([id, data]) => ({ id, ...(data || {}) }));
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

module.exports = { addHistory, getRecentRooms };