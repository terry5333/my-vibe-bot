"use strict";

const { getDb } = require("./firestore");

const COLLECTION = "users";

async function addPoints(userId, amount) {
  const db = getDb();
  const ref = db.collection(COLLECTION).doc(userId);

  await db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const current = doc.exists ? doc.data().points || 0 : 0;
    t.set(ref, { points: current + amount }, { merge: true });
  });
}

async function setPoints(userId, amount) {
  const db = getDb();
  await db.collection(COLLECTION).doc(userId).set(
    { points: amount },
    { merge: true }
  );
}

async function getPoints(userId) {
  const db = getDb();
  const doc = await db.collection(COLLECTION).doc(userId).get();
  if (!doc.exists) return 0;
  return doc.data().points || 0;
}

async function getLeaderboard(limit = 10) {
  const db = getDb();
  const snap = await db
    .collection(COLLECTION)
    .orderBy("points", "desc")
    .limit(limit)
    .get();

  return snap.docs.map((d) => ({
    userId: d.id,
    points: d.data().points || 0,
  }));
}

module.exports = {
  addPoints,
  setPoints,
  getPoints,
  getLeaderboard,
};