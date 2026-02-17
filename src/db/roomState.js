"use strict";

/**
 * Firestore 房間狀態 / 原子鎖
 * doc 路徑：roomState/{guildId_userId}
 *
 * tryLockRoom：用 transaction 保證多進程只有一個成功
 * setRoomActive：寫入 channelId
 * clearRoom：清掉狀態
 */

const initFirebase = require("./initFirebase");

function keyOf(guildId, userId) {
  return `${guildId}_${userId}`;
}

function now() {
  return Date.now();
}

// lock 過期時間（避免死鎖），建房通常幾秒就結束
const LOCK_TTL_MS = 25 * 1000;

async function getDb() {
  const admin = initFirebase();
  if (!admin) throw new Error("Firebase not initialized");
  return admin.firestore();
}

async function tryLockRoom({ guildId, userId, gameKey }) {
  const db = await getDb();
  const ref = db.collection("roomState").doc(keyOf(guildId, userId));

  try {
    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const data = snap.exists ? snap.data() : null;

      // 已有有效房間
      if (data?.active && data.channelId) {
        return { ok: false, reason: "active_exists", channelId: data.channelId };
      }

      // 有 lock 但還沒過期 => 代表另一個進程正在建
      if (data?.lockedUntil && data.lockedUntil > now()) {
        return { ok: false, reason: "locked" };
      }

      // 取得 lock（原子）
      t.set(
        ref,
        {
          guildId,
          userId,
          gameKey,
          active: false,
          channelId: null,
          lockedUntil: now() + LOCK_TTL_MS,
          updatedAt: now(),
        },
        { merge: true }
      );

      return { ok: true };
    });

    return result;
  } catch (e) {
    console.error("❌ Firestore tryLockRoom error:", e);
    return { ok: false, reason: "error" };
  }
}

async function setRoomActive({ guildId, userId, gameKey, channelId }) {
  const db = await getDb();
  const ref = db.collection("roomState").doc(keyOf(guildId, userId));

  await ref.set(
    {
      guildId,
      userId,
      gameKey,
      active: true,
      channelId,
      lockedUntil: 0,
      updatedAt: now(),
    },
    { merge: true }
  );
}

async function clearRoom({ guildId, userId }) {
  const db = await getDb();
  const ref = db.collection("roomState").doc(keyOf(guildId, userId));

  await ref.set(
    {
      active: false,
      channelId: null,
      lockedUntil: 0,
      updatedAt: now(),
    },
    { merge: true }
  );
}

module.exports = {
  tryLockRoom,
  setRoomActive,
  clearRoom,
};