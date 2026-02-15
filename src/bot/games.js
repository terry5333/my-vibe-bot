"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require("discord.js");

const { getDB } = require("../db/firebase");
const { addPoints, getPoints } = require("../db/points");
const {
  upsertUserProfile,
  setActiveRoom,
  clearActiveRoom,
  appendRoomEvent,
  pushRoomEventRolling,
  makeRoomId,
} = require("../db/logs");

function now() { return Date.now(); }
function randInt(min, max) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}
function isIntStr(t) { return /^-?\d+$/.test(t); }

const DEFAULT_CONFIG = Object.freeze({
  vip: { enabled: false, guildId: "", roleId: "", threshold: 1000 },
  weekly: { enabled: false, topN: 3, reward: 100 },
});

const configCache = { value: JSON.parse(JSON.stringify(DEFAULT_CONFIG)) };

async function initConfigListeners() {
  const db = getDB();
  db.ref("config").on("value", (snap) => {
    const raw = snap.val() || {};
    const vip = raw.vip || {};
    const weekly = raw.weekly || {};
    configCache.value = {
      vip: {
        enabled: !!vip.enabled,
        guildId: String(vip.guildId || ""),
        roleId: String(vip.roleId || ""),
        threshold: Math.max(1, Number(vip.threshold || DEFAULT_CONFIG.vip.threshold)),
      },
      weekly: {
        enabled: !!weekly.enabled,
        topN: Math.max(1, Number(weekly.topN || DEFAULT_CONFIG.weekly.topN)),
        reward: Math.max(1, Number(weekly.reward || DEFAULT_CONFIG.weekly.reward)),
      },
    };
    console.log("[Config] updated");
  });
}
function getConfig() { return configCache.value; }

// ===== Active games =====
const guessGame = new Map(); // channelId -> {active, answer, min, max, roomId}
const hlGame = new Map();    // userId -> {current, streak, roomId, guildId}
const countingGame = new Map(); // channelId -> {active, start, next, lastUserId, reward, guildId, roomId}
const countingStoppedAt = new Map(); // channelId -> ts
const STOP_BLOCK_MS = 60_000;

const COUNTING_PATH = "counting"; // 持久狀態（用來恢復）

function makeHLButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("hl:higher").setLabel("更大").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hl:lower").setLabel("更小").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("hl:stop").setLabel("結束").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

// ===== User profile sync =====
async function syncUser(user) {
  const avatar = user.displayAvatarURL({ size: 128, extension: "png" });
  await upsertUserProfile(user.id, { name: user.username, avatar });
}

// ===== Counting persistence =====
async function loadCountingState(guildId, channelId) {
  const db = getDB();
  const snap = await db.ref(`${COUNTING_PATH}/${guildId}/${channelId}`).get();
  const v = snap.val();
  if (!v || !v.active) return null;
  return {
    active: true,
    start: Number(v.start) || 1,
    next: Number(v.next) || Number(v.start) || 1,
    lastUserId: v.lastUserId || null,
    reward: Number(v.reward) || 1,
    guildId,
    roomId: v.roomId || null,
  };
}
async function saveCountingState(guildId, channelId, state) {
  const db = getDB();
  await db.ref(`${COUNTING_PATH}/${guildId}/${channelId}`).set({
    active: !!state.active,
    start: state.start,
    next: state.next,
    lastUserId: state.lastUserId || null,
    reward: state.reward,
    roomId: state.roomId || null,
    updatedAt: now(),
  });
}
async function stopCountingState(guildId, channelId) {
  const db = getDB();
  await db.ref(`${COUNTING_PATH}/${guildId}/${channelId}`).set({
    active: false,
    updatedAt: now(),
  });
}

// ===== VIP auto role =====
async function maybeAssignVipRole(client, userId, points) {
  const cfg = getConfig().vip;
  if (!cfg.enabled) return;
  if (!cfg.guildId || !cfg.roleId) return;
  if (points < cfg.threshold) return;

  const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
  if (!guild) return;
  const me = await guild.members.fetchMe().catch(() => null);
  if (!me) return;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;

  const role = await guild.roles.fetch(cfg.roleId).catch(() => null);
  if (!role) return;
  if (me.roles.highest.comparePositionTo(role) <= 0) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  if (member.roles.cache.has(cfg.roleId)) return;

  await member.roles.add(cfg.roleId).catch(() => {});
}

// ===== Weekly payout =====
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
async function getTopN(n) {
  const db = getDB();
  const snap = await db.ref("points").orderByValue().limitToLast(n).get();
  const val = snap.val() || {};
  return Object.entries(val)
    .map(([userId, pts]) => ({ userId, points: Number(pts) || 0 }))
    .sort((a, b) => b.points - a.points);
}
async function payoutWeeklyTop(client) {
  const cfg = getConfig().weekly;
  if (!cfg.enabled) return { ok: false, msg: "每週結算未啟用（到後台啟用）" };

  const top = await getTopN(cfg.topN);
  if (!top.length) return { ok: false, msg: "目前沒有任何分數資料。" };

  const db = getDB();
  const weekKey = isoWeekKey(new Date());
  const lockRef = db.ref(`weeklyLocks/${weekKey}`);
  const lockSnap = await lockRef.get();
  if (lockSnap.exists()) return { ok: false, msg: `本週（${weekKey}）已發放過。` };

  const results = [];
  for (const r of top) {
    const newPts = await addPoints(r.userId, cfg.reward);
    await maybeAssignVipRole(client, r.userId, newPts);
    results.push({ ...r, newPts });
  }

  await lockRef.set({
    weekKey,
    reward: cfg.reward,
    topN: cfg.topN,
    issuedAt: now(),
    winners: results.map((x) => ({ userId: x.userId, before: x.points, after: x.newPts })),
  });

  return { ok: true, weekKey, reward: cfg.reward, topN: cfg.topN, results };
}

// ===== Force stop from admin =====
async function forceStopGuess(guildId, channelId) {
  const g = guessGame.get(channelId);
  if (g?.active) guessGame.delete(channelId);
  await clearActiveRoom("guess", guildId, channelId);
}
async function forceStopHL(guildId, userId) {
  if (hlGame.has(userId)) hlGame.delete(userId);
  await clearActiveRoom("hl", guildId, userId);
}
async function forceStopCounting(guildId, channelId) {
  countingGame.delete(channelId);
  countingStoppedAt.set(channelId, now());
  await stopCountingState(guildId, channelId);
  await clearActiveRoom("counting", guildId, channelId);
}

// ===== Public API for web =====
function getLiveRoomsSnapshot() {
  const guess = [...guessGame.entries()].filter(([, g]) => g?.active).map(([channelId, g]) => ({
    channelId,
    min: g.min,
    max: g.max,
    roomId: g.roomId || null,
  }));
  const hl = [...hlGame.entries()].map(([userId, s]) => ({
    userId,
    current: s.current,
    streak: s.streak,
    guildId: s.guildId,
    roomId: s.roomId || null,
  }));
  const counting = [...countingGame.entries()].filter(([, c]) => c?.active).map(([channelId, c]) => ({
    channelId,
    guildId: c.guildId,
    next: c.next,
    start: c.start,
    reward: c.reward,
    lastUserId: c.lastUserId,
    roomId: c.roomId || null,
  }));
  return { guess, counting, hl };
}

// ===== Handlers for discord events =====
async function onGuessCommand(client, interaction) {
  await interaction.deferReply({ ephemeral: false });
  await syncUser(interaction.user);

  const channelId = interaction.channelId;
  const guildId = interaction.guildId;

  // counting 開著不給 guess
  const c = countingGame.get(channelId);
  if (c?.active) return interaction.editReply("此頻道正在進行【數字接龍】，請先 `/counting stop`。");

  const existing = guessGame.get(channelId);
  if (existing?.active) return interaction.editReply(`此頻道已經有終極密碼（${existing.min} ~ ${existing.max}）直接猜！`);

  const min = interaction.options.getInteger("min") ?? 1;
  const max = interaction.options.getInteger("max") ?? 100;
  const realMin = Math.min(min, max);
  const realMax = Math.max(min, max);
  if (realMax - realMin < 3) return interaction.editReply("範圍太小，至少 1~4。");

  const answer = randInt(realMin + 1, realMax - 1);

  const roomId = await setActiveRoom("guess", {
    guildId,
    key: channelId,
    channelId,
    title: "Guess",
    state: { min: realMin, max: realMax },
    startedAt: now(),
  });

  guessGame.set(channelId, { active: true, answer, min: realMin, max: realMax, roomId });

  await pushRoomEventRolling(roomId, { kind: "start", min: realMin, max: realMax });
  await appendRoomEvent("guess", guildId, channelId, { kind: "start", min: realMin, max: realMax });

  return interaction.editReply(
    `🎯 終極密碼開始！範圍：**${realMin} ~ ${realMax}**（不含邊界）\n直接在此頻道輸入整數猜。\n✅ 猜中 +50 分！`
  );
}

async function onHLCommand(client, interaction) {
  await interaction.deferReply({ ephemeral: false });
  await syncUser(interaction.user);

  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const current = randInt(1, 13);

  const roomId = await setActiveRoom("hl", {
    guildId,
    key: userId,
    userId,
    title: "HL",
    state: { current, streak: 0 },
    startedAt: now(),
  });

  hlGame.set(userId, { current, streak: 0, roomId, guildId });

  await pushRoomEventRolling(roomId, { kind: "start", current });
  await appendRoomEvent("hl", guildId, userId, { kind: "start", current });

  return interaction.editReply({
    content: `🃏 高低牌開始！目前牌：**${current}**（1~13）\n猜對每回合 +5 分（會顯示總分）`,
    components: makeHLButtons(),
  });
}

async function onCountingCommand(client, interaction) {
  if (!interaction.inGuild()) return interaction.reply({ content: "此指令只能在伺服器使用。", ephemeral: true });
  await int
