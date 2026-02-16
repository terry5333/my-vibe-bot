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
 * ✅ 全域加分函數（必須）
 * - 使用 transaction 防止同時寫入打架
 * - 寫入成功才回傳最新分數
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

module.exports = { getPoints, setPoints, addPoints };
