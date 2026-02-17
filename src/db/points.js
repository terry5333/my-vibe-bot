"use strict";

/**
 * Firestore 積分系統（使用 FIREBASE_SERVICE_ACCOUNT_B64）
 * - 有 Firebase：寫入 Firestore
 * - 沒 Firebase：fallback 用記憶體，避免機器人直接死掉
 */

const initFirebase = require("./initFirebase"); // ✅ 你那支 initFirebase.js

let db = null;
let col = null;

// fallback（沒有 Firebase 時）
const mem = new Map(); // userId -> points

function ensureDb() {
  if (db && col) return true;

  const admin = initFirebase();
  if (!admin) return false;

  db = admin.firestore();
  col = db.collection("points");
  return true;
}

async function getPoints(userId) {
  if (!ensureDb()) {
    return mem.get(userId) || 0;
  }

  const doc = await col.doc(String(userId)).get();
  if (!doc.exists) return 0;
  return Number(doc.data()?.points || 0);
}

async function addPoints(userId, amount) {
  amount = Number(amount) || 0;
  if (amount === 0) return;

  const uid = String(userId);

  if (!ensureDb()) {
    const cur = mem.get(uid) || 0;
    const next = cur + amount;
    mem.set(uid, next);
    console.log("[Points] (MEM) addPoints:", uid, next);
    return;
  }

  const ref = col.doc(uid);

  await db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const current = doc.exists ? Number(doc.data()?.points || 0) : 0;
    const next = current + amount;

    t.set(ref, { points: next }, { merge: true });
  });

  // 這行不要放 transaction 裡面（避免重複 log）
  // console.log("✅ Firestore addPoints:", uid, amount);
}

async function setPoints(userId, amount) {
  amount = Number(amount) || 0;
  const uid = String(userId);

  if (!ensureDb()) {
    mem.set(uid, amount);
    console.log("[Points] (MEM) setPoints:", uid, amount);
    return;
  }

  await col.doc(uid).set({ points: amount }, { merge: true });
  // console.log("✅ Firestore setPoints:", uid, amount);
}

module.exports = {
  getPoints,
  addPoints,
  setPoints,
};