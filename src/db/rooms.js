"use strict";

const admin = require("firebase-admin");

/**
 * Firebase RTDB 結構建議：
 * /rooms/{roomId} = { roomId, guildId, channelId, game, status, updatedAt, ... }
 * /settings = { ... }
 */

function db() {
  // 你的 initFirebase() 要先呼叫過，admin 才會 initialized
  return admin.database();
}

async function getRooms() {
  const snap = await db().ref("rooms").once("value");
  const val = snap.val() || {};
  return Object.values(val).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function setRoom(roomId, patch = {}) {
  if (!roomId) throw new Error("roomId required");
  const ref = db().ref(`rooms/${roomId}`);
  const snap = await ref.once("value");
  const prev = snap.val() || { roomId };
  const next = {
    ...prev,
    ...patch,
    roomId,
    updatedAt: Date.now(),
  };
  await ref.set(next);
  return next;
}

async function removeRoom(roomId) {
  if (!roomId) throw new Error("roomId required");
  await db().ref(`rooms/${roomId}`).remove();
  return true;
}

/**
 * 後台強制停止：
 * 只負責寫狀態（讓 bot 的遊戲邏輯看到後停掉）
 * 你的遊戲程式（games/events）要去讀 rooms/{roomId}.stopRequested 才能真的停
 */
async function forceStop(roomId, game = "all") {
  if (!roomId) throw new Error("roomId required");
  const patch = {
    status: "stopping",
    stopRequested: { game, at: Date.now() },
  };
  const next = await setRoom(roomId, patch);
  return next;
}

async function getSettings() {
  const snap = await db().ref("settings").once("value");
  return snap.val() || {};
}

async function setSettings(payload = {}) {
  const ref = db().ref("settings");
  const snap = await ref.once("value");
  const prev = snap.val() || {};
  const next = { ...prev, ...(payload || {}), updatedAt: Date.now() };
  await ref.set(next);
  return next;
}

module.exports = {
  getRooms,
  setRoom,
  removeRoom,
  forceStop,
  getSettings,
  setSettings,
};
