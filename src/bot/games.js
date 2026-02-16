"use strict";

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require("discord.js");
const { addPoints } = require("../db/points");
const { getDB } = require("../db/firebase");

/**
 * ✅ 遊戲狀態隔離：
 * - guess/counting：以 channelId 為單位（同頻道只能一個）
 * - hl：以 userId 為單位（每個人自己一局）
 */
const gameData = {
  guessByChannel: new Map(),
  countingByChannel: new Map(),
  hlByUser: new Map(),
};

// ====== History（最近7天） ======
async function pushHistory(room) {
  const db = getDB();
  const now = Date.now();
  await db.ref(`history/${now}`).set(room);
}

// ====== Profiles（給後台顯示頭像/名字） ======
async function upsertProfile(user) {
  try {
    const db = getDB();
    const avatar =
      user.displayAvatarURL?.({ size: 128 }) ||
      user.avatarURL?.({ size: 128 }) ||
      null;
    await db.ref(`profiles/${user.id}`).update({
      name: user.username ?? null,
      avatar: avatar ?? null,
      updatedAt: Date.now(),
    });
  } catch {}
}

// ====== Leaderboard cache（/rank 秒回） ======
const leaderboardCache = {
  ts: 0,
  items: [],
};
async function refreshLeaderboardCache() {
  const db = getDB();
  const snap = await db.ref("points").get();
  const points = snap.val() ?? {};
  const items = Object.keys(points)
    .map((userId) => ({ userId, points: Number(points[userId] ?? 0) }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 50);
  leaderboardCache.ts = Date.now();
  leaderboardCache.items = items;
}
function getLeaderboardCache() {
  return leaderboardCache;
}
async function ensureLeaderboardWarm() {
  if (Date.now() - leaderboardCache.ts > 60_000) {
    await refreshLeaderboardCache();
  }
}

// =============== Guess（終極密碼） ===============
async function startGuess(interaction, webRuntime) {
  const channelId = interaction.channelId;
  const min = interaction.options.getInteger("min");
  const max = interaction.options.getInteger("max");

  await interaction.deferReply({ ephemeral: true });

  if (min >= max) {
    return interaction.editReply("❌ min 必須小於 max");
  }
  if (gameData.guessByChannel.has(channelId)) {
    return interaction.editReply("⚠️ 這個頻道已經有終極密碼在進行中。");
  }

  const answer = Math.floor(Math.random() * (max - min + 1)) + min;

  const room = {
    type: "guess",
    channelId,
    startedAt: Date.now(),
    min,
    max,
    answer,
    active: true,
    logs: [],
  };

  gameData.guessByChannel.set(channelId, room);
  webRuntime.rooms.set(channelId, room);

  await interaction.editReply(`✅ 終極密碼已開始：請在頻道輸入 ${min} ~ ${max} 的數字！`);
}

async function handleGuessMessage(msg) {
  const room = gameData.guessByChannel.get(msg.channelId);
  if (!room || !room.active) return;

  // 只吃純數字
  const n = Number(msg.content.trim());
  if (!Number.isInteger(n)) return;

  // 記錄
  room.logs.push({ t: Date.now(), userId: msg.author.id, value: n });
  if (room.logs.length > 200) room.logs.shift();

  if (n < room.min || n > room.max) {
    return msg.reply(`⚠️ 範圍是 ${room.min} ~ ${room.max}`);
  }

  if (n === room.answer) {
    // ✅ 猜中：加 50 分 + 公告訊息
    const newPoints = await addPoints(msg.author.id, 50);
    await upsertProfile(msg.author);

    room.active = false;
    gameData.guessByChannel.delete(msg.channelId);

    // 寫歷史
    await pushHistory({
      type: "guess",
      channelId: msg.channelId,
      endedAt: Date.now(),
      winnerId: msg.author.id,
      logs: room.logs,
    });

    await msg.channel.send(`🎉 <@${msg.author.id}> 猜中了！答案是 **${room.answer}**\n✅ 獲得 **+50** 分（目前：${newPoints}）`);
  } else if (n < room.answer) {
    await msg.reply("📉 太小了");
  } else {
    await msg.reply("📈 太大了");
  }
}

// =============== Counting（此頻道一局） ===============
async function startCounting(interaction, webRuntime) {
  const channelId = interaction.channelId;
  await interaction.deferReply({ ephemeral: true });

  if (gameData.countingByChannel.has(channelId)) {
    return interaction.editReply("⚠️ 這個頻道已經有 counting 在進行中。");
  }

  const room = {
    type: "counting",
    channelId,
    startedAt: Date.now(),
    active: true,
    next: 1,
    lastUserId: null,
    logs: [],
  };

  gameData.countingByChannel.set(channelId, room);
  webRuntime.rooms.set(channelId, room);

  await interaction.editReply("✅ Counting 開始！請依序輸入 **1** 開始（連續同一人不算）。");
  await interaction.channel.send("🧮 Counting 開始！現在請輸入：**1**");
}

async function handleCountingMessage(msg) {
  const room = gameData.countingByChannel.get(msg.channelId);
  if (!room || !room.active) return;

  const n = Number(msg.content.trim());
  if (!Number.isInteger(n)) return;

  // 停止後不應回覆：active=false 就直接 return（上面已擋）
  // 同一人連續
  if (room.lastUserId === msg.author.id) {
    await msg.reply("⚠️ 不能連續同一個人喔！");
    return;
  }

  if (n !== room.next) {
    // 失敗：重置
    room.logs.push({ t: Date.now(), userId: msg.author.id, value: n, ok: false });
    room.active = false;
    gameData.countingByChannel.delete(msg.channelId);

    await pushHistory({
      type: "counting",
      channelId: msg.channelId,
      endedAt: Date.now(),
      failAt: room.next,
      logs: room.logs,
    });

    await msg.channel.send(`💥 失敗！正確應該是 **${room.next}**，本局結束。`);
    return;
  }

  // 成功
  room.logs.push({ t: Date.now(), userId: msg.author.id, value: n, ok: true });
  if (room.logs.length > 400) room.logs.shift();

  room.lastUserId = msg.author.id;
  room.next += 1;

  // ✅ 每次正確 +1 分（你要改成別的倍率也可）
  const newPoints = await addPoints(msg.author.id, 1);
  await upsertProfile(msg.author);

  await msg.react("✅").catch(() => {});
  await msg.reply(`✅ 正確！+1 分（目前：${newPoints}），下一個：**${room.next}**`);
}

// =============== HL（高低牌，個人一局） ===============
function drawCard() {
  return Math.floor(Math.random() * 13) + 1; // 1~13
}
function cardName(v) {
  const map = { 1: "A", 11: "J", 12: "Q", 13: "K" };
  return map[v] ?? String(v);
}

async function startHL(interaction, webRuntime) {
  const userId = interaction.user.id;
  await interaction.deferReply();

  if (gameData.hlByUser.has(userId)) {
    return interaction.editReply("⚠️ 你已經有一局 HL 在進行中了。");
  }

  const first = drawCard();
  const room = {
    type: "hl",
    userId,
    channelId: interaction.channelId,
    startedAt: Date.now(),
    active: true,
    current: first,
    score: 0,
    logs: [{ t: Date.now(), card: first }],
  };

  gameData.hlByUser.set(userId, room);
  webRuntime.rooms.set(`hl:${userId}`, room);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hl_hi:${userId}`).setLabel("更高").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hl_lo:${userId}`).setLabel("更低").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hl_stop:${userId}`).setLabel("結束").setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    content: `🃏 HL 開始！目前牌：**${cardName(first)}**\n猜下一張是更高還更低？（猜對 +5 分）`,
    components: [row],
  });
}

async function handleHLButton(interaction) {
  const [key, userId] = interaction.customId.split(":");
  if (!userId) return;

  // 只能本人按
  if (interaction.user.id !== userId) {
    return interaction.reply({ content: "⚠️ 這不是你的遊戲。", ephemeral: true });
  }

  const room = gameData.hlByUser.get(userId);
  if (!room || !room.active) {
    return interaction.reply({ content: "⚠️ 你的 HL 已結束。", ephemeral: true });
  }

  if (key === "hl_stop") {
    room.active = false;
    gameData.hlByUser.delete(userId);

    await pushHistory({
      type: "hl",
      channelId: room.channelId,
      userId,
      endedAt: Date.now(),
      score: room.score,
      logs: room.logs,
    });

    return interaction.update({
      content: `✅ 已結束 HL。本局連勝：**${room.score}**`,
      components: [],
    });
  }

  const guessHigh = key === "hl_hi";
  const next = drawCard();
  const ok = guessHigh ? next > room.current : next < room.current;

  room.logs.push({ t: Date.now(), guess: guessHigh ? "hi" : "lo", card: next, ok });
  if (room.logs.length > 200) room.logs.shift();

  if (!ok || next === room.current) {
    room.active = false;
    gameData.hlByUser.delete(userId);

    await pushHistory({
      type: "hl",
      channelId: room.channelId,
      userId,
      endedAt: Date.now(),
      score: room.score,
      logs: room.logs,
    });

    return interaction.update({
      content: `💥 你猜錯了！\n上一張：**${cardName(room.current)}** → 這張：**${cardName(next)}**\n本局連勝：**${room.score}**`,
      components: [],
    });
  }

  // ✅ 猜對 +5
  room.current = next;
  room.score += 1;
  const newPoints = await addPoints(userId, 5);
  await upsertProfile(interaction.user);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hl_hi:${userId}`).setLabel("更高").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hl_lo:${userId}`).setLabel("更低").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hl_stop:${userId}`).setLabel("結束").setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    content: `✅ 猜對！+5 分（目前：${newPoints}）\n目前牌：**${cardName(next)}**\n連勝：**${room.score}**`,
    components: [row],
  });
}

// =============== Stop（管理員停止） ===============
async function stopChannelGame(interaction, webRuntime) {
  await interaction.deferReply({ ephemeral: true });

  const member = interaction.member;
  const ok =
    member &&
    (member.permissions?.has(PermissionsBitField.Flags.Administrator) ||
      member.permissions?.has(PermissionsBitField.Flags.ManageGuild));

  if (!ok) return interaction.editReply("❌ 你沒有權限使用 /stop");

  const cid = interaction.channelId;

  let stopped = [];
  const g = gameData.guessByChannel.get(cid);
  if (g?.active) {
    g.active = false;
    gameData.guessByChannel.delete(cid);
    stopped.push("guess");
  }

  const c = gameData.countingByChannel.get(cid);
  if (c?.active) {
    c.active = false;
    gameData.countingByChannel.delete(cid);
    stopped.push("counting");
  }

  webRuntime.rooms.delete(cid);

  if (!stopped.length) return interaction.editReply("⚠️ 這個頻道目前沒有進行中的遊戲。");
  return interaction.editReply(`✅ 已停止：${stopped.join(",
