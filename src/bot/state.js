"use strict";

/**
 * src/bot/state.js
 * 集中管理遊戲狀態（記憶體版）
 * - counting：數字接龍
 * - guess：猜數字（終極密碼）
 * - hl：高低（High/Low）猜下一張牌大小（簡化版）
 */

const rooms = new Map(); // key: guildId:channelId

function key(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function ensureRoom(guildId, channelId) {
  const k = key(guildId, channelId);
  if (!rooms.has(k)) {
    rooms.set(k, {
      roomId: k,
      guildId,
      channelId,
      status: "idle",
      game: null,
      updatedAt: Date.now(),
      startedAt: null,

      counting: {
        on: false,
        last: null,
        lastUserId: null,
        streak: 0,
      },

      guess: {
        on: false,
        min: 1,
        max: 100,
        ans: null,
      },

      hl: {
        on: false,
        current: null, // 1~13
        streak: 0,
      },
    });
  }
  return rooms.get(k);
}

function touch(room) {
  room.updatedAt = Date.now();
  return room;
}

/* ------------------- getters for web/admin ------------------- */
function getRooms() {
  return Array.from(rooms.values()).map((r) => ({
    roomId: r.roomId,
    guildId: r.guildId,
    channelId: r.channelId,
    status: r.status,
    game: r.game,
    updatedAt: r.updatedAt,
    startedAt: r.startedAt,
  }));
}

/* ------------------- Counting ------------------- */
function countingStart(guildId, channelId) {
  const r = ensureRoom(guildId, channelId);
  r.status = "running";
  r.game = "counting";
  r.startedAt = Date.now();
  r.counting.on = true;
  r.counting.last = 0;
  r.counting.lastUserId = null;
  r.counting.streak = 0;
  return touch(r);
}

function countingStop(guildId, channelId) {
  const r = ensureRoom(guildId, channelId);
  r.counting.on = false;
  if (r.game === "counting") {
    r.status = "idle";
    r.game = null;
    r.startedAt = null;
  }
  return touch(r);
}

function countingStatus(guildId, channelId) {
  const r = ensureRoom(guildId, channelId);
  return {
    on: r.counting.on,
    last: r.counting.last,
    lastUserId: r.counting.lastUserId,
    streak: r.counting.streak,
    game: r.game,
  };
}

function countingFeedMessage({ guildId, channelId, userId, content }) {
  const r = ensureRoom(guildId, channelId);
  if (!r.counting.on) return { ok: false, reason: "NOT_RUNNING" };

  const n = Number(String(content).trim());
  if (!Number.isFinite(n)) return { ok: false, reason: "NOT_NUMBER" };

  // 不能連續同一人
  if (r.counting.lastUserId && r.counting.lastUserId === userId) {
    // 失敗重置
    r.counting.last = 0;
    r.counting.lastUserId = null;
    r.counting.streak = 0;
    touch(r);
    return { ok: false, reason: "SAME_USER" };
  }

  // 必須是 last + 1
  const want = (r.counting.last ?? 0) + 1;
  if (n !== want) {
    r.counting.last = 0;
    r.counting.lastUserId = null;
    r.counting.streak = 0;
    touch(r);
    return { ok: false, reason: "WRONG_NUMBER", want };
  }

  // 成功
  r.counting.last = n;
  r.counting.lastUserId = userId;
  r.counting.streak = (r.counting.streak ?? 0) + 1;
  touch(r);
  return { ok: true, value: n, streak: r.counting.streak };
}

/* ------------------- Guess ------------------- */
function guessStart(guildId, channelId, min = 1, max = 100) {
  const r = ensureRoom(guildId, channelId);
  r.status = "running";
  r.game = "guess";
  r.startedAt = Date.now();
  r.guess.on = true;
  r.guess.min = Number(min) || 1;
  r.guess.max = Number(max) || 100;
  r.guess.ans = Math.floor(Math.random() * (r.guess.max - r.guess.min + 1)) + r.guess.min;
  return touch(r);
}

function guessStop(guildId, channelId) {
  const r = ensureRoom(guildId, channelId);
  r.guess.on = false;
  if (r.game === "guess") {
    r.status = "idle";
    r.game = null;
    r.startedAt = null;
  }
  return touch(r);
}

function guessTry(guildId, channelId, n) {
  const r = ensureRoom(guildId, channelId);
  if (!r.guess.on) return { ok: false, reason: "NOT_RUNNING" };

  const x = Number(n);
  if (!Number.isFinite(x)) return { ok: false, reason: "BAD_NUMBER" };

  if (x === r.guess.ans) {
    const ans = r.guess.ans;
    guessStop(guildId, channelId);
    return { ok: true, hit: true, ans };
  }
  if (x < r.guess.ans) {
    r.guess.min = Math.max(r.guess.min, x);
    touch(r);
    return { ok: true, hit: false, hint: "UP", min: r.guess.min, max: r.guess.max };
  }
  r.guess.max = Math.min(r.guess.max, x);
  touch(r);
  return { ok: true, hit: false, hint: "DOWN", min: r.guess.min, max: r.guess.max };
}

/* ------------------- HL (High/Low) ------------------- */
function hlStart(guildId, channelId) {
  const r = ensureRoom(guildId, channelId);
  r.status = "running";
  r.game = "hl";
  r.startedAt = Date.now();
  r.hl.on = true;
  r.hl.current = Math.floor(Math.random() * 13) + 1; // 1~13
  r.hl.streak = 0;
  return touch(r);
}

function hlStop(guildId, channelId) {
  const r = ensureRoom(guildId, channelId);
  r.hl.on = false;
  if (r.game === "hl") {
    r.status = "idle";
    r.game = null;
    r.startedAt = null;
  }
  return touch(r);
}

function hlPick(guildId, channelId, pick /* "high"|"low" */) {
  const r = ensureRoom(guildId, channelId);
  if (!r.hl.on) return { ok: false, reason: "NOT_RUNNING" };

  const next = Math.floor(Math.random() * 13) + 1;
  const cur = r.hl.current;

  let win = false;
  if (pick === "high") win = next > cur;
  if (pick === "low") win = next < cur;

  if (win) r.hl.streak += 1;
  else r.hl.streak = 0;

  r.hl.current = next;
  touch(r);

  return { ok: true, cur, next, win, streak: r.hl.streak };
}

module.exports = {
  // rooms/admin
  getRooms,

  // counting
  countingStart,
  countingStop,
  countingStatus,
  countingFeedMessage,

  // guess
  guessStart,
  guessStop,
  guessTry,

  // hl
  hlStart,
  hlStop,
  hlPick,
};