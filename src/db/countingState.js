"use strict";

/**
 * src/db/countingState.js
 * Firestore: counting
 */

const initFirebase = require("./initFirebase");

function mustDb() {
  const admin = initFirebase();
  if (!admin) throw new Error("Firebase not initialized");
  return admin.firestore();
}

function docId(guildId, channelId) {
  return `${guildId}_${channelId}`;
}

async function getCounting(guildId, channelId) {
  const db = mustDb();
  const ref = db.collection("counting").doc(docId(guildId, channelId));
  const snap = await ref.get();
  if (!snap.exists) {
    return { state: "stopped", expected: 1, lastUserId: null };
  }
  const d = snap.data() || {};
  return {
    state: d.state || "stopped",
    expected: Number.isFinite(d.expected) ? d.expected : 1,
    lastUserId: d.lastUserId || null,
  };
}

async function setCounting(guildId, channelId, patch) {
  const db = mustDb();
  const ref = db.collection("counting").doc(docId(guildId, channelId));
  await ref.set(
    {
      guildId,
      channelId,
      ...patch,
      updatedAt: Date.now(),
    },
    { merge: true }
  );
}

async function resetCounting(guildId, channelId, start = 1) {
  await setCounting(guildId, channelId, {
    state: "playing",
    expected: start,
    lastUserId: null,
  });
}

module.exports = {
  getCounting,
  setCounting,
  resetCounting,
};