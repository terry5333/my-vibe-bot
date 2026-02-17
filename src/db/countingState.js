"use strict";

/**
 * Firestore Counting 狀態
 * doc 路徑：countingState/{guildId}
 */

const initFirebase = require("./initFirebase");

async function getDb() {
  const admin = initFirebase();
  if (!admin) throw new Error("Firebase not initialized");
  return admin.firestore();
}

async function getCounting(guildId) {
  const db = await getDb();
  const ref = db.collection("countingState").doc(String(guildId));
  const snap = await ref.get();
  if (!snap.exists) {
    return { guildId, state: "stopped", channelId: null, expected: 1, lastUserId: null };
  }
  const d = snap.data() || {};
  return {
    guildId,
    state: d.state || "stopped",
    channelId: d.channelId || null,
    expected: typeof d.expected === "number" ? d.expected : 1,
    lastUserId: d.lastUserId || null,
  };
}

async function setCounting(guildId, channelId, patch) {
  const db = await getDb();
  const ref = db.collection("countingState").doc(String(guildId));

  await ref.set(
    {
      guildId,
      channelId: channelId || null,
      ...patch,
      updatedAt: Date.now(),
    },
    { merge: true }
  );
}

module.exports = {
  getCounting,
  setCounting,
};