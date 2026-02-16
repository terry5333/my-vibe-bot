"use strict";

const { getDB } = require("./firebase");

/**
 * rooms 結構建議：
 * rooms/{roomId} = { status, game, updatedAt, ... }
 * settings/{guildId} = { ... }
 */

async function getRooms() {
  const db = getDB();
  const snap = await db.ref("rooms").get();
  const val = snap.val() || {};
  return Object.entries(val).map(([roomId, data]) => ({ roomId, ...(data || {}) }));
}

async function upsertRoom(roomId, patch) {
  const db = getDB();
  const ref = db.ref(`rooms/${roomId}`);
  await ref.update({
    ...(patch || {}),
    updatedAt: Date.now(),
  });
  const snap = await ref.get();
  return snap.val();
}

async function forceStop(roomId, game = "all") {
  // 你如果有更細的遊戲狀態管理，這裡可以改成清掉指定 game
  return upsertRoom(roomId, {
    status: "stopped",
    game,
    stoppedAt: Date.now(),
  });
}

async function getSettings(guildId = "global") {
  const db = getDB();
  const snap = await db.ref(`settings/${guildId}`).get();
  return snap.val() || {};
}

async function setSettings(guildId = "global", payload = {}) {
  const db = getDB();
  await db.ref(`settings/${guildId}`).set(payload);
  return payload;
}

module.exports = {
  getRooms,
  upsertRoom,
  forceStop,
  getSettings,
  setSettings,
};