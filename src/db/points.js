"use strict";

/**
 * Firestore 積分系統
 */

const admin = require("firebase-admin");

let db;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

db = admin.firestore();
const col = db.collection("points");

async function getPoints(userId) {
  const doc = await col.doc(userId).get();
  if (!doc.exists) return 0;
  return doc.data().points || 0;
}

async function addPoints(userId, amount) {
  const ref = col.doc(userId);

  await db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const current = doc.exists ? (doc.data().points || 0) : 0;
    const next = current + amount;

    t.set(ref, { points: next }, { merge: true });

    console.log("✅ Firestore 寫入成功:", userId, next);
  });
}

async function setPoints(userId, amount) {
  await col.doc(userId).set({ points: amount }, { merge: true });
  console.log("✅ Firestore set:", userId, amount);
}

module.exports = {
  getPoints,
  addPoints,
  setPoints,
};