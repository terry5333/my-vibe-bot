"use strict";

/**
 * 這個 state 是「保底」：就算 rooms/history DB 還沒完善，
 * Web 也可以靠這裡讀 rooms、forceStop、settings。
 */

const state = {
  rooms: new Map(), // roomId -> { roomId, game, status, updatedAt, ... }
  settings: {},
  stopRequests: [], // 記錄後台要求停遊戲
};

function upsertRoom(roomId, patch = {}) {
  if (!roomId) return null;
  const prev = state.rooms.get(roomId) || { roomId };
  const next = {
    ...prev,
    ...patch,
    roomId,
    updatedAt: Date.now(),
  };
  state.rooms.set(roomId, next);
  return next;
}

function removeRoom(roomId) {
  return state.rooms.delete(roomId);
}

function getRooms() {
  return Array.from(state.rooms.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * 後台強制停止：
 * - 先記錄請求（讓你的遊戲事件邏輯可以去讀 stopRequests 並真的停）
 * - 同時把 room 狀態標為 stopped（web 立即看得見）
 */
function forceStop(roomId, game = "all") {
  const req = { roomId, game, at: Date.now() };
  state.stopRequests.push(req);

  upsertRoom(roomId, {
    status: "stopping",
    stopGame: game,
  });

  return { requested: true, ...req };
}

function popStopRequests() {
  // 給 bot 事件去消化（你可以在 events / games 裡定期呼叫）
  const arr = state.stopRequests.slice();
  state.stopRequests.length = 0;
  return arr;
}

function getSettings() {
  return state.settings || {};
}

function setSettings(payload = {}) {
  state.settings = { ...(state.settings || {}), ...(payload || {}) };
  return state.settings;
}

module.exports = {
  upsertRoom,
  removeRoom,
  getRooms,
  forceStop,
  popStopRequests,
  getSettings,
  setSettings,
};
