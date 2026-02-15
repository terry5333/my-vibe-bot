"use strict";

const { getDB } = require("./firebase");

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function makeRoomId(type, guildId, channelIdOrUserId) {
  return `${type}_${guildId}_${channelIdOrUserId}`;
}

async function upsertUserProfile(userId, profile) {
  const db = getDB();
  await db.ref(`users/${userId}`).update({
    name: String(profile.name || ""),
    avatar: String(profile.avatar || ""),
    updatedAt: Date.now(),
  });
}

async function setActiveRoom(type, room) {
  const db = getDB();
  const rid = makeRoomId(type, room.guildId, room.key);
  await db.ref(`games/active/${type}/${rid}`).set({
    roomId: rid,
    type,
    guildId: room.guildId,
    channelId: room.channelId || null,
    userId: room.userId || null,
    title: room.title || "",
    state: room.state || {},
    startedAt: room.startedAt || Date.now(),
    updatedAt: Date.now(),
  });
  return rid;
}

async function clearActiveRoom(type, guildId, key) {
  const db = getDB();
  const rid = makeRoomId(type, guildId, key);
  await db.ref(`games/active/${type}/${rid}`).remove();
}

async function appendRoomEvent(type, guildId, key, event) {
  const db = getDB();
  const rid = makeRoomId(type, guildId, key);
  const dk = dayKey();
  const base = db.ref(`games/history/${dk}/${rid}`);
  await base.child("meta").update({
    roomId: rid,
    type,
    guildId,
    key,
    updatedAt: Date.now(),
  });
  await base.child("events").push({
    ...event,
    ts: Date.now(),
  });
  // 也放一份最新快照方便後台「房間管理」秒看
  await db.ref(`games/rooms/${rid}/latest`).set({
    ...event,
    ts: Date.now(),
  });
  await db.ref(`games/rooms/${rid}/meta`).update({
    roomId: rid,
    type,
    guildId,
    key,
    updatedAt: Date.now(),
  });
}

async function getActiveRoomsAll() {
  const db = getDB();
  const snap = await db.ref("games/active").get();
  return snap.val() || {};
}

async function getRoomRecentEvents(roomId, limit = 30) {
  const db = getDB();
  // 先從 games/rooms 取（跨天也能看最近）
  const snap = await db.ref(`games/rooms/${roomId}/events`).limitToLast(limit).get();
  const val = snap.val() || {};
  const arr = Object.entries(val).map(([id, v]) => ({ id, ...v }));
  arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return arr;
}

async function pushRoomEventRolling(roomId, event) {
  const db = getDB();
  await db.ref(`games/rooms/${roomId}/events`).push({ ...event, ts: Date.now() });
  await db.ref(`games/rooms/${roomId}/meta`).update({ updatedAt: Date.now() });
}

async function listHistoryDays(days = 7) {
  const db = getDB();
  const snap = await db.ref("games/history").get();
  const root = snap.val() || {};
  const keys = Object.keys(root).sort().reverse();
  return keys.slice(0, Math.max(1, Math.min(14, Number(days) || 7)));
}

async function listHistoryRoomsByDay(dk) {
  const db = getDB();
  const snap = await db.ref(`games/history/${dk}`).get();
  const v = snap.val() || {};
  const rooms = [];
  for (const [roomId, data] of Object.entries(v)) {
    rooms.push({
      roomId,
      meta: data.meta || {},
    });
  }
  rooms.sort((a, b) => (b.meta.updatedAt || 0) - (a.meta.updatedAt || 0));
  return rooms;
}

async function getHistoryRoomEvents(dk, roomId, limit = 200) {
  const db = getDB();
  const snap = await db.ref(`games/history/${dk}/${roomId}/events`).limitToLast(limit).get();
  const val = snap.val() || {};
  const arr = Object.entries(val).map(([id, v]) => ({ id, ...v }));
  arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return arr;
}

// 7 天保留：每天清一次（只清 games/history）
function startHistoryCleanup() {
  const db = getDB();
  setInterval(async () => {
    try {
      const snap = await db.ref("games/history").get();
      const root = snap.val() || {};
      const keys = Object.keys(root).sort(); // old -> new
      const keep = 7;

      while (keys.length > keep) {
        const k = keys.shift();
        await db.ref(`games/history/${k}`).remove();
        console.log("[History] cleaned", k);
      }
    } catch (e) {
      console.error("[History] cleanup failed", e);
    }
  }, 24 * 60 * 60 * 1000);
}

module.exports = {
  dayKey,
  makeRoomId,
  upsertUserProfile,
  setActiveRoom,
  clearActiveRoom,
  appendRoomEvent,
  pushRoomEventRolling,
  getActiveRoomsAll,
  getRoomRecentEvents,
  listHistoryDays,
  listHistoryRoomsByDay,
  getHistoryRoomEvents,
  startHistoryCleanup,
};
