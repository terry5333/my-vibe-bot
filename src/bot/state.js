"use strict";

/**
 * 這是一個「可選」的 runtime 狀態模組。
 * 如果你想記憶體內紀錄房間狀態，後台也能讀到。
 * 沒用到也沒關係，server.js 會優先用 db/rooms.js
 */

const _state = {
  rooms: new Map(), // roomId -> data
  settings: {},
};

function getRooms() {
  return Array.from(_state.rooms.entries()).map(([roomId, data]) => ({ roomId, ...(data || {}) }));
}

function setRoom(roomId, patch) {
  const cur = _state.rooms.get(roomId) || {};
  const next = { ...cur, ...(patch || {}), updatedAt: Date.now() };
  _state.rooms.set(roomId, next);
  return next;
}

function forceStop(roomId, game = "all") {
  return setRoom(roomId, { status: "stopped", game, stoppedAt: Date.now() });
}

function getSettings() {
  return _state.settings || {};
}

function setSettings(payload) {
  _state.settings = payload || {};
  return _state.settings;
}

module.exports = {
  getRooms,
  setRoom,
  forceStop,
  getSettings,
  setSettings,
};