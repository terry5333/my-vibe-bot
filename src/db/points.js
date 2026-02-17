"use strict";

const initFirebase = require("./initFirebase");

function getDb() {
  const admin = initFirebase();
  if (!admin) return null;
  return admin.firestore();
}

function col(db) {
  return db.collection("points");
}

async function getPoints(userId) {
  const db = getDb();
  if (!db) return 0;
  const doc = await col(db).doc(userId).get();
  if (!doc.exists) return 0;
  return doc.data().points || 0;
}

async function addPoints(userId, amount) {
  const db = getDb();
  if (!db) return;

  const ref = col(db).doc(userId);

  await db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const current = doc.exists ? (doc.data().points || 0) : 0;
    const next = current + amount;
    t.set(ref, { points: next }, { merge: true });
  });
}

async function setPoints(userId, amount) {
  const db = getDb();
  if (!db) return;
  await col(db).doc(userId).set({ points: amount }, { merge: true });
}

/** ✅ 排行榜：取前 N 名 */
async function getTop(limit = 10) {
  const db = getDb();
  if (!db) return [];
  const snap = await col(db).orderBy("points", "desc").limit(limit).get();
  return snap.docs.map((d) => ({ userId: d.id, points: d.data().points || 0 }));
}

module.exports = { getPoints, addPoints, setPoints, getTop };