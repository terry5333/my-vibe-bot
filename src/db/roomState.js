"use strict";

/**
 * src/db/roomState.js
 * Firestore: roomLocks / rooms
 *
 * 需求：
 * - 多進程 / 多副本下，按一次只建立一間房（distributed lock）
 * - 能查到使用者是否已有房（避免兩間）
 *
 * env:
 * - FIREBASE_SERVICE_ACCOUNT_B64 (base64 JSON service account)
 */

const initFirebase = require("./initFirebase");

function mustDb() {
  const admin = initFirebase();
  if (!admin) throw new Error("Firebase not initialized");
  return admin.firestore();
}

const LOCK_TTL_MS = 15 * 1000; // 15 秒鎖，避免死鎖
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 房狀態保留 1 天（可調）

function lockDocId(guildId, userId) {
  return `${guildId}_${userId}`;
}
function roomDocId(guildId, userId) {
  return `${guildId}_${userId}`;
}

async function tryLockRoom({ guildId, userId, gameKey }) {
  const db = mustDb();
  const now = Date.now();

  const lockRef = db.collection("roomLocks").doc(lockDocId(guildId, userId));
  const roomRef = db.collection("rooms").doc(roomDocId(guildId, userId));

  try {
    const result = await db.runTransaction(async (t) => {
      const roomSnap = await t.get(roomRef);
      if (roomSnap.exists) {
        const data = roomSnap.data() || {};
        // 如果已經有 active 房，直接回覆
        if (data.active && data.channelId) {
          return { ok: false, reason: "active_exists", channelId: data.channelId };
        }
      }

      const lockSnap = await t.get(lockRef);
      if (lockSnap.exists) {
        const lock = lockSnap.data() || {};
        const expiresAt = Number(lock.expiresAt || 0);
        if (expiresAt > now) {
          return { ok: false, reason: "locked" };
        }
      }

      // 建立鎖
      t.set(
        lockRef,
        {
          guildId,
          userId,
          gameKey,
          createdAt: now,
          expiresAt: now + LOCK_TTL_MS,
        },
        { merge: true }
      );

      return { ok: true };
    });

    return result;
  } catch (e) {
    console.error("❌ tryLockRoom error:", e);
    return { ok: false, reason: "error" };
  }
}

async function setRoomActive({ guildId, userId, gameKey, channelId }) {
  const db = mustDb();
  const now = Date.now();
  const roomRef = db.collection("rooms").doc(roomDocId(guildId, userId));
  const lockRef = db.collection("roomLocks").doc(lockDocId(guildId, userId));

  await db.runTransaction(async (t) => {
    t.set(
      roomRef,
      {
        guildId,
        userId,
        gameKey,
        channelId,
        active: true,
        updatedAt: now,
        expiresAt: now + ROOM_TTL_MS,
      },
      { merge: true }
    );
    // 建完房就把鎖清掉（避免鎖卡住）
    t.delete(lockRef);
  });
}

async function clearRoom({ guildId, userId }) {
  const db = mustDb();
  const roomRef = db.collection("rooms").doc(roomDocId(guildId, userId));
  const lockRef = db.collection("roomLocks").doc(lockDocId(guildId, userId));

  await db.runTransaction(async (t) => {
    t.delete(roomRef);
    t.delete(lockRef);
  });
}

async function getActiveRoom({ guildId, userId }) {
  const db = mustDb();
  const roomRef = db.collection("rooms").doc(roomDocId(guildId, userId));
  const snap = await roomRef.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (!data.active || !data.channelId) return null;
  return data;
}

module.exports = {
  tryLockRoom,
  setRoomActive,
  clearRoom,
  getActiveRoom,
};