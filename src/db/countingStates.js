"use strict";

const initFirebase = require("./initFirebase");

function db() {
  const admin = initFirebase();
  if (!admin) return null;
  return admin.firestore();
}

/**
 * counting/{guildId_channelId} = { state, expected, lastUserId, updatedAt }
 * state: "playing" | "paused" | "stopped"
 */
function key(guildId, channelId) {
  return `${guildId}_${channelId}`;
}

async function setCounting(guildId, channelId, patch) {
  const firestore = db();
  if (!firestore) return;
  await firestore.collection("counting").doc(key(guildId, channelId)).set(
    { ...patch, updatedAt: Date.now() },
    { merge: true }
  );
}

async function getCounting(guildId, channelId) {
  const firestore = db();
  if (!firestore) return null;
  const snap = await firestore.collection("counting").doc(key(guildId, channelId)).get();
  if (!snap.exists) return { state: "stopped", expected: 1, lastUserId: null };
  const d = snap.data() || {};
  return {
    state: d.state || "stopped",
    expected: Number.isFinite(d.expected) ? d.expected : 1,
    lastUserId: d.lastUserId || null,
  };
}

module.exports = { setCounting, getCounting };