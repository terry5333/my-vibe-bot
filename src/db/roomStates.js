"use strict";

const initFirebase = require("./initFirebase");

function db() {
  const admin = initFirebase();
  if (!admin) return null;
  return admin.firestore();
}

/**
 * rooms/{guildId_userId} = {
 *   status: "creating" | "active",
 *   gameKey,
 *   channelId,
 *   updatedAt
 * }
 */
async function tryLockRoom({ guildId, userId, gameKey, ttlMs = 15000 }) {
  const firestore = db();
  if (!firestore) return { ok: true, reason: "no_db" }; // 沒 DB 就退回原本行為

  const key = `${guildId}_${userId}`;
  const ref = firestore.collection("rooms").doc(key);

  const now = Date.now();

  return await firestore.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const data = snap.exists ? snap.data() : null;

    // 已有 active room：直接回傳 existing
    if (data?.status === "active" && data?.channelId) {
      return { ok: false, reason: "active_exists", channelId: data.channelId, gameKey: data.gameKey };
    }

    // 正在 creating：若沒過期，擋住
    if (data?.status === "creating" && data?.updatedAt && now - data.updatedAt < ttlMs) {
      return { ok: false, reason: "creating_in_progress" };
    }

    // 取得 lock
    t.set(ref, { status: "creating", gameKey, updatedAt: now }, { merge: true });
    return { ok: true };
  });
}

async function setRoomActive({ guildId, userId, gameKey, channelId }) {
  const firestore = db();
  if (!firestore) return;

  const key = `${guildId}_${userId}`;
  await firestore.collection("rooms").doc(key).set(
    { status: "active", gameKey, channelId, updatedAt: Date.now() },
    { merge: true }
  );
}

async function clearRoom({ guildId, userId }) {
  const firestore = db();
  if (!firestore) return;
  const key = `${guildId}_${userId}`;
  await firestore.collection("rooms").doc(key).delete().catch(() => {});
}

module.exports = { tryLockRoom, setRoomActive, clearRoom };