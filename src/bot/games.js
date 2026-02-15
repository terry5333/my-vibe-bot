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
  await interaction.deferReply({ ephemeral: true });
  await syncUser(interaction.user);

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  // guess 開著不給 counting
  const g = guessGame.get(channelId);
  if (sub === "start" && g?.active) return interaction.editReply("此頻道正在進行【終極密碼】，先結束再開接龍。");

  if (sub === "start") {
    const start = interaction.options.getInteger("start") ?? 1;
    const reward = interaction.options.getInteger("reward") ?? 1;
    if (!Number.isInteger(start)) return interaction.editReply("start 必須是整數。");
    if (!Number.isInteger(reward) || reward <= 0) return interaction.editReply("reward 必須是正整數。");

    const roomId = await setActiveRoom("counting", {
      guildId,
      key: channelId,
      channelId,
      title: "Counting",
      state: { start, next: start, reward },
      startedAt: now(),
    });

    const state = { active: true, start, next: start, lastUserId: null, reward, guildId, roomId };
    countingGame.set(channelId, state);
    countingStoppedAt.delete(channelId);

    await saveCountingState(guildId, channelId, state);

    await pushRoomEventRolling(roomId, { kind: "start", start, reward });
    await appendRoomEvent("counting", guildId, channelId, { kind: "start", start, reward });

    await interaction.channel.send(
      `🔢 數字接龍已啟動！請從 **${start}** 開始。\n規則：同一人不能連續｜正確 +${reward} 分（會顯示總分）`
    );
    return interaction.editReply("✅ 已啟動數字接龍。");
  }

  if (sub === "stop") {
    const cur = countingGame.get(channelId) || (await loadCountingState(guildId, channelId));
    countingGame.delete(channelId);
    countingStoppedAt.set(channelId, now());
    await stopCountingState(guildId, channelId);
    await clearActiveRoom("counting", guildId, channelId);

    if (cur?.roomId) {
      await pushRoomEventRolling(cur.roomId, { kind: "stop", by: interaction.user.id });
      await appendRoomEvent("counting", guildId, channelId, { kind: "stop", by: interaction.user.id });
    }

    await interaction.channel.send("🛑 數字接龍已停止。");
    return interaction.editReply("✅ 已停止接龍。");
  }

  if (sub === "status") {
    const s = countingGame.get(channelId) || (await loadCountingState(guildId, channelId));
    if (!s?.active) return interaction.editReply("此頻道目前沒有啟用數字接龍。");
    countingGame.set(channelId, s);
    return interaction.editReply(`✅ 接龍啟用中\n下一個：**${s.next}**｜每次 +${s.reward} 分`);
  }
}

async function onSetupRoleCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.inGuild()) return interaction.editReply("此指令只能在伺服器使用。");

  const role = interaction.options.getRole("role");
  const label = interaction.options.getString("label") || `切換身分組：${role.name}`;

  const me = interaction.guild.members.me;
  if (!me) return interaction.editReply("讀不到我的成員資訊，請稍後再試。");
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return interaction.editReply("我沒有 **Manage Roles** 權限。");
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`role:toggle:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary)
  );

  await interaction.channel.send({ content: `🔘 點按鈕切換：<@&${role.id}>`, components: [row] });
  return interaction.editReply("✅ 已送出身分組切換按鈕。");
}

async function onWeeklyCommand(client, interaction) {
  const isAdmin =
    interaction.inGuild() &&
    (interaction.memberPermissions?.has?.(PermissionsBitField.Flags.Administrator) ||
      interaction.memberPermissions?.has?.(PermissionsBitField.Flags.ManageGuild));

  if (!isAdmin) return interaction.reply({ content: "❌ 只有管理員可以使用。", ephemeral: true });

  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: false });

  if (sub === "preview") {
    const cfg = getConfig().weekly;
    if (!cfg.enabled) return interaction.editReply("每週結算未啟用（到後台啟用）。");

    const top = await getTopN(cfg.topN);
    if (!top.length) return interaction.editReply("目前沒有任何分數資料。");

    const lines = top.map((x, i) => `**#${i + 1}** <@${x.userId}> — ${x.points}`);
    return interaction.editReply(`📅 本週 Top ${cfg.topN}\n${lines.join("\n")}\n\n🎁 每人 +${cfg.reward} 分`);
  }

  if (sub === "payout") {
    const out = await payoutWeeklyTop(client);
    if (!out.ok) return interaction.editReply(`❌ ${out.msg}`);

    const lines = out.results.map(
      (x, i) => `**#${i + 1}** <@${x.userId}> ✅ +${out.reward}（新總分：${x.newPts}）`
    );
    return interaction.editReply(`🎉 已發放（${out.weekKey}）\n${lines.join("\n")}`);
  }
}

// ===== messageCreate (Guess + Counting) =====
async function onMessageCreate(client, message) {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    await syncUser(message.author);

    const channelId = message.channel.id;
    const guildId = message.guild.id;
    const text = message.content.trim();

    // Guess 優先：避免跟 counting 搞混
    const g = guessGame.get(channelId);
    if (g?.active) {
      if (!isIntStr(text)) return;
      const n = Number(text);
      if (!Number.isInteger(n)) return;

      await pushRoomEventRolling(g.roomId, { kind: "guess", userId: message.author.id, value: n });
      await appendRoomEvent("guess", guildId, channelId, { kind: "guess", userId: message.author.id, value: n });

      if (n <= g.min || n >= g.max) {
        await message.reply(`請猜 **${g.min} ~ ${g.max}** 之間（不含邊界）。`);
        return;
      }

      if (n === g.answer) {
        guessGame.delete(channelId);
        await clearActiveRoom("guess", guildId, channelId);

        await message.reply(`🎉 猜中！答案是 **${g.answer}**\n正在加分中…`);

        try {
          const newPts = await addPoints(message.author.id, 50);
          await maybeAssignVipRole(client, message.author.id, newPts);

          await pushRoomEventRolling(g.roomId, { kind: "hit", userId: message.author.id, add: 50, total: newPts });
          await appendRoomEvent("guess", guildId, channelId, { kind: "hit", userId: message.author.id, add: 50, total: newPts });

          await message.channel.send(`<@${message.author.id}> ✅ +50 分（總分：**${newPts}**）`);
        } catch (e) {
          await message.channel.send(`<@${message.author.id}> 你應得 +50 分，但加分失敗（請管理員查 Firebase/Logs）`);
        }
        return;
      }

      if (n < g.answer) {
        g.min = n;
        await pushRoomEventRolling(g.roomId, { kind: "range", min: g.min, max: g.max });
        await appendRoomEvent("guess", guildId, channelId, { kind: "range", min: g.min, max: g.max });
        await message.reply(`太小了！新範圍：**${g.min} ~ ${g.max}**`);
      } else {
        g.max = n;
        await pushRoomEventRolling(g.roomId, { kind: "range", min: g.min, max: g.max });
        await appendRoomEvent("guess", guildId, channelId, { kind: "range", min: g.min, max: g.max });
        await message.reply(`太大了！新範圍：**${g.min} ~ ${g.max}**`);
      }
      return;
    }

    // counting stop-block：停了 60 秒內不回
    const stoppedAt = countingStoppedAt.get(channelId);
    if (stoppedAt && now() - stoppedAt < STOP_BLOCK_MS) return;

    // Counting：必要時從 DB 恢復
    let c = countingGame.get(channelId);
    if (!c) {
      const loaded = await loadCountingState(guildId, channelId);
      if (loaded) {
        countingGame.set(channelId, loaded);
        c = loaded;
        // 若缺 roomId，補一個
        if (!c.roomId) {
          const rid = await setActiveRoom("counting", {
            guildId,
            key: channelId,
            channelId,
            title: "Counting",
            state: { start: c.start, next: c.next, reward: c.reward },
            startedAt: now(),
          });
          c.roomId = rid;
          await saveCountingState(guildId, channelId, c);
        }
      }
    }

    if (c?.active) {
      if (!isIntStr(text)) return;
      const n = Number(text);
      if (!Number.isInteger(n)) return;

      await pushRoomEventRolling(c.roomId, { kind: "say", userId: message.author.id, value: n });
      await appendRoomEvent("counting", guildId, channelId, { kind: "say", userId: message.author.id, value: n });

      if (c.lastUserId && c.lastUserId === message.author.id) {
        await message.reply("⛔ 同一人不能連續兩次！請換別人接。");
        await pushRoomEventRolling(c.roomId, { kind: "reject", reason: "repeat_user", userId: message.author.id });
        return;
      }

      if (n !== c.next) {
        const bad = c.next;
        c.next = c.start;
        c.lastUserId = null;
        await saveCountingState(guildId, channelId, c);

        await message.reply(`❌ 接錯了！你傳 **${n}**，應該是 **${bad}**。\n已重置，請從 **${c.start}** 重新開始。`);
        await pushRoomEventRolling(c.roomId, { kind: "fail", userId: message.author.id, got: n, expected: bad, resetTo: c.start });
        await appendRoomEvent("counting", guildId, channelId, { kind: "fail", userId: message.author.id, got: n, expected: bad
