"use strict";

const { getDB } = require("./firebase");

async function getPoints(userId) {
  const db = getDB();
  const snap = await db.ref(`points/${userId}`).get();
  return Number(snap.val() ?? 0);
}

async function setPoints(userId, value) {
  const db = getDB();
  const v = Number(value) || 0;
  await db.ref(`points/${userId}`).set(v);
  return v;
}

async function addPoints(userId, delta) {
  const db = getDB();
  const d = Number(delta) || 0;

  // Realtime DB transaction：避免同時加分打架
  const ref = db.ref(`points/${userId}`);
  const result = await ref.transaction((cur) => {
    const curNum = Number(cur ?? 0);
    return curNum + d;
  });

  if (!result.committed) throw new Error("transaction not committed");
  return Number(result.snapshot.val() ?? 0);
}

module.exports = { getPoints, setPoints, addPoints };
