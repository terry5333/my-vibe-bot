"use strict";

/**
 * src/bot/games.js
 * 需要在你的 bot/events.js 裡面接：
 *
 * const games = require("./games");
 * client.on("interactionCreate", (i) => games.handleInteraction(client, i));
 * client.on("messageCreate", (m) => games.handleMessage(client, m));
 *
 * ⚠️ 你的 client intents 必須包含 GatewayIntentBits.MessageContent
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
} = require("discord.js");

const { addPoints, getPoints, getTopPoints } = require("../db/points"); // 你 points.js 要有這些
// 如果你 points.js 目前只有 addPoints，你也可以先把 getPoints/getTopPoints 做成 stub

/* ==============================
   In-memory Game Rooms & History
================================ */

const rooms = new Map(); // key: `${guildId}:${channelId}` -> room object
const history7d = []; // { ts, guildId, channelId, type, events: [...], winnerId? }

/**
 * room structure:
 * {
 *   guildId, channelId, type: 'counting'|'guess'|'hl',
 *   active: true,
 *   createdAt,
 *   ownerId,
 *   meta: {...},
 *   log: [{ts, type, ...}]
 * }
 */

function roomKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function now() {
  return Date.now();
}

function pushHistoryIfEnded(room, extra = {}) {
  // 清掉超過 7 天
  const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
  while (history7d.length && history7d[0].ts < cutoff) history7d.shift();

  history7d.push({
    ts: now(),
    guildId: room.guildId,
    channelId: room.channelId,
    type: room.type,
    events: room.log.slice(-300), // 保留最後 300 筆避免爆
    ...extra,
  });
}

function getRoom(guildId, channelId) {
  return rooms.get(roomKey(guildId, channelId)) || null;
}

function setRoom(room) {
  rooms.set(roomKey(room.guildId, room.channelId), room);
}

function deleteRoom(guildId, channelId) {
  rooms.delete(roomKey(guildId, channelId));
}

/* ==============================
   Safe interaction helpers
================================ */

async function safeDefer(interaction, ephemeral = false) {
  try {
    if (interaction.deferred || interaction.replied) return;
    await interaction.deferReply({ ephemeral });
  } catch {}
}

async function safeEdit(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }
    return await interaction.reply(payload);
  } catch {}
}

async function safeFollow(interaction, payload) {
  try {
    return await interaction.followUp(payload);
  } catch {}
}

/* ==============================
   Utility: Permissions checks
================================ */

function isAdminMember(member) {
  try {
    if (!member) return false;
    return member.permissions.has(PermissionsBitField.Flags.Administrator);
  } catch {
    return false;
  }
}

function mustInGuild(interaction) {
  if (!interaction.guildId) {
    safeEdit(interaction, { content: "❌ 這個指令只能在伺服器內使用。" });
    return false;
  }
  return true;
}

/* ==============================
   Points wrapper (always await)
================================ */

async function award(interactionOrMsg, userId, amount, reason) {
  // addPoints 必須是 async，並且真的寫入成功才回傳
  const res = await addPoints(userId, amount, reason || "game");
  return res;
}

/* ==============================
   Game: Guess (終極密碼)
================================ */

function createGuessRoom(guildId, channelId, ownerId) {
  const target = Math.floor(Math.random() * 100) + 1; // 1~100
  const room = {
    guildId,
    channelId,
    ownerId,
    type: "guess",
    active: true,
    createdAt: now(),
    meta: {
      min: 1,
      max: 100,
      target,
      attempts: 0,
    },
    log: [],
  };
  room.log.push({ ts: now(), type: "start", targetHidden: true });
  return room;
}

async function startGuess(interaction) {
  if (!mustInGuild(interaction)) return;
  await safeDefer(interaction, false);

  const key = roomKey(interaction.guildId, interaction.channelId);
  const existing = rooms.get(key);
  if (existing && existing.active) {
    return safeEdit(interaction, {
      content: `⚠️ 本頻道已有進行中的遊戲：**${existing.type}**（請先 /stop 停止）`,
    });
  }

  const room = createGuessRoom(interaction.guildId, interaction.channelId, interaction.user.id);
  rooms.set(key, room);

  return safeEdit(interaction, {
    content:
      "🎯 **終極密碼開始！**\n" +
      `請在這個頻道輸入 1~100 的數字來猜。\n` +
      `猜中者獲得 **+50 分**！`,
  });
}

async function handleGuessMessage(msg, room) {
  // 只處理文字數字
  const n = Number(msg.content);
  if (!Number.isInteger(n)) return;
  if (n < room.meta.min || n > room.meta.max) return;

  room.meta.attempts += 1;
  room.log.push({ ts: now(), type: "guess", userId: msg.author.id, n });

  if (n === room.meta.target) {
    // 猜中：回覆 + 加分 + 關房
    await msg.reply(`🎉 ${msg.author} 猜中了！答案是 **${n}**，獲得 **+50 分**！`);

    try {
      await award(msg, msg.author.id, 50, "guess_win");
    } catch (e) {
      // 加分失敗也要告知
      await msg.channel.send("⚠️ 加分時發生錯誤，請稍後再試。");
    }

    room.log.push({ ts: now(), type: "win", userId: msg.author.id, n });
    room.active = false;

    pushHistoryIfEnded(room, { winnerId: msg.author.id });
    deleteRoom(room.guildId, room.channelId);
    return;
  }

  // 沒猜中：縮範圍並提示
  if (n < room.meta.target) {
    room.meta.min = Math.max(room.meta.min, n + 1);
  } else {
    room.meta.max = Math.min(room.meta.max, n - 1);
  }

  await msg.reply(`❌ 不對！範圍縮小：**${room.meta.min} ~ ${room.meta.max}**`);
}

/* ==============================
   Game: Counting
================================ */

function createCountingRoom(guildId, channelId, ownerId) {
  const room = {
    guildId,
    channelId,
    ownerId,
    type: "counting",
    active: true,
    createdAt: now(),
    meta: {
      next: 1,
      lastUserId: null,
      streak: 0,
    },
    log: [],
  };
  room.log.push({ ts: now(), type: "start", next: 1 });
  return room;
}

async function startCounting(interaction) {
  if (!mustInGuild(interaction)) return;
  await safeDefer(interaction, false);

  const key = roomKey(interaction.guildId, interaction.channelId);
  const existing = rooms.get(key);
  if (existing && existing.active) {
    return safeEdit(interaction, {
      content: `⚠️ 本頻道已有進行中的遊戲：**${existing.type}**（請先 /stop 停止）`,
    });
  }

  const room = createCountingRoom(interaction.guildId, interaction.channelId, interaction.user.id);
  rooms.set(key, room);

  return safeEdit(interaction, {
    content: "🔢 **Counting 開始！**\n請依序輸入數字：從 **1** 開始。\n規則：不能連續兩次同一人。",
  });
}

async function stopCountingRoom(interaction, room) {
  room.active = false;
  room.log.push({ ts: now(), type: "stop", by: interaction.user.id });
  pushHistoryIfEnded(room, { stoppedBy: interaction.user.id });
  deleteRoom(room.guildId, room.channelId);

  // ✅ 這行就是你之前炸掉的地方：保證完整一行
  return interaction.editReply("✅ 已停止：counting");
}

async function handleCountingMessage(msg, room) {
  // 房間已關就不管（防止你說的「停止後還回」）
  if (!room.active) return;

  // 只吃純數字
  const n = Number(msg.content);
  if (!Number.isInteger(n)) return;

  // 不能連續同人
  if (room.meta.lastUserId && room.meta.lastUserId === msg.author.id) {
    room.log.push({ ts: now(), type: "invalid", reason: "same_user", userId: msg.author.id, n });
    await msg.reply(`❌ 不行喔！不能連續兩次同一個人。下一個應該是 **${room.meta.next}**`);
    return;
  }

  // 不是正確下一個數字
  if (n !== room.meta.next) {
    room.log.push({ ts: now(), type: "invalid", reason: "wrong_number", userId: msg.author.id, n });
    await msg.reply(`❌ 數字錯了！下一個應該是 **${room.meta.next}**`);
    return;
  }

  // 正確
  room.meta.lastUserId = msg.author.id;
  room.meta.next += 1;
  room.meta.streak += 1;

  room.log.push({ ts: now(), type: "ok", userId: msg.author.id, n, next: room.meta.next });

  // ✅ 你要的「表情符號」：每次正確就給 ✅
  await msg.react("✅").catch(() => {});

  // ✅ 設計：每 5 次連續正確，最後那個人 +3 分（避免每次都狂寫 DB）
  if (room.meta.streak % 5 === 0) {
    try {
      await award(msg, msg.author.id, 3, "counting_milestone");
      await msg.reply(`🎁 恭喜達成連續 **${room.meta.streak}** 次！${msg.author} 獲得 **+3 分**`);
    } catch {
      await msg.channel.send("⚠️ 加分時發生錯誤，請稍後再試。");
    }
  }
}

/* ==============================
   Game: HL (高低牌)
================================ */

function drawCard() {
  // 1~13
  return Math.floor(Math.random() * 13) + 1;
}

function cardText(v) {
  if (v === 1) return "A";
  if (v === 11) return "J";
  if (v === 12) return "Q";
  if (v === 13) return "K";
  return String(v);
}

function createHLRoom(guildId, channelId, ownerId) {
  const current = drawCard();
  const room = {
    guildId,
    channelId,
    ownerId,
    type: "hl",
    active: true,
    createdAt: now(),
    meta: {
      playerId: ownerId,
      current,
      rounds: 0,
      wins: 0,
      messageId: null,
    },
    log: [],
  };
  room.log.push({ ts: now(), type: "start", current });
  return room;
}

function hlComponents(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("hl_high")
        .setLabel("更高")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("hl_low")
        .setLabel("更低")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("hl_stop")
        .setLabel("停止")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    ),
  ];
}

async function startHL(interaction) {
  if (!mustInGuild(interaction)) return;
  await safeDefer(interaction, false);

  const key = roomKey(interaction.guildId, interaction.channelId);
  const existing = rooms.get(key);
  if (existing && existing.active) {
    return safeEdit(interaction, {
      content: `⚠️ 本頻道已有進行中的遊戲：**${existing.type}**（請先 /stop 停止）`,
    });
  }

  const room = createHLRoom(interaction.guildId, interaction.channelId, interaction.user.id);
  rooms.set(key, room);

  const embed = new EmbedBuilder()
    .setTitle("🃏 高低牌（HL）")
    .setDescription(
      `目前牌：**${cardText(room.meta.current)}**\n` +
        `由 <@${room.meta.playerId}> 進行挑戰。\n\n` +
        `每次猜對 **+5 分**（立即更新按鈕訊息）。`
    )
    .setFooter({ text: "按下「更高 / 更低」開始" });

  const msg = await safeEdit(interaction, { embeds: [embed], components: hlComponents(false) });
  // interaction.editReply 回傳 Message 可能拿不到，保險用 fetch
  try {
    const sent = await interaction.fetchReply();
    room.meta.messageId = sent.id;
  } catch {}
}

async function stopHLRoom(interaction, room, reason = "stopped") {
  room.active = false;
  room.log.push({ ts: now(), type: "stop", by: interaction.user.id, reason });
  pushHistoryIfEnded(room, { stoppedBy: interaction.user.id });
  deleteRoom(room.guildId, room.channelId);

  const embed = new EmbedBuilder()
    .setTitle("🃏 高低牌（HL）已結束")
    .setDescription(`本局結束。勝利次數：**${room.meta.wins}**`)
    .setFooter({ text: "你可以重新 /hl 開新局" });

  return interaction.update({ embeds: [embed], components: hlComponents(true) });
}

async function handleHLButton(interaction, room, pick) {
  // 房間已關
  if (!room.active) {
    return interaction.reply({ content: "⚠️ 這局已結束。", ephemeral: true }).catch(() => {});
  }

  // 只允許開局者玩（避免別人亂按）
  if (interaction.user.id !== room.meta.playerId) {
    return interaction.reply({ content: "❌ 只有開局者可以操作。", ephemeral: true }).catch(() => {});
  }

  const prev = room.meta.current;
  const next = drawCard();
  room.meta.rounds += 1;

  const isHigh = next > prev;
  const isLow = next < prev;
  const isTie = next === prev;

  let ok = false;
  if (!isTie) {
    if (pick === "high" && isHigh) ok = true;
    if (pick === "low" && isLow) ok = true;
  }

  room.log.push({
    ts: now(),
    type: "round",
    userId: interaction.user.id,
    prev,
    next,
    pick,
    ok,
  });

  if (ok) {
    room.meta.current = next;
    room.meta.wins += 1;

    // ✅ 猜對立刻加分 + 更新訊息（你說的「猜對沒反應」就是要 update）
    try {
      await award(interaction, interaction.user.id, 5, "hl_win");
    } catch {
      // 不影響 UI 更新，但要提示
      await interaction.followUp({ content: "⚠️ 加分失敗，請稍後再試。", ephemeral: true }).catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setTitle("🃏 高低牌（HL）")
      .setDescription(
        `上一張：**${cardText(prev)}**\n` +
          `新牌：**${cardText(next)}**\n\n` +
          `✅ 猜對！<@${interaction.user.id}> 獲得 **+5 分**\n` +
          `目前連勝：**${room.meta.wins}**`
      )
      .setFooter({ text: "繼續猜！" });

    return interaction.update({ embeds: [embed], components: hlComponents(false) });
  }

  // 猜錯 or 平手 -> 結束
  room.active = false;
  pushHistoryIfEnded(room, { winnerId: interaction.user.id, endedByMistake: true });
  deleteRoom(room.guildId, room.channelId);

  const embed = new EmbedBuilder()
    .setTitle("🃏 高低牌（HL）結束")
    .setDescription(
      `上一張：**${cardText(prev)}**\n` +
        `新牌：**${cardText(next)}**\n\n` +
        (isTie ? "🤝 平手（視為失敗結束）\n" : "❌ 猜錯了！\n") +
        `本局連勝：**${room.meta.wins}**`
    )
    .setFooter({ text: "你可以重新 /hl 開新局" });

  return interaction.update({ embeds: [embed], components: hlComponents(true) });
}

/* ==============================
   Stop command (停止本頻道遊戲)
================================ */

async function stopAny(interaction) {
  if (!mustInGuild(interaction)) return;
  await safeDefer(interaction, false);

  const room = getRoom(interaction.guildId, interaction.channelId);
  if (!room || !room.active) {
    return safeEdit(interaction, { content: "⚠️ 本頻道沒有進行中的遊戲。" });
  }

  // 允許：房主 or 管理員 停止
  const member = interaction.member;
  const isOwner = room.ownerId === interaction.user.id;
  const isAdmin = isAdminMember(member);

  if (!isOwner && !isAdmin) {
    return safeEdit(interaction, { content: "❌ 只有開局者或管理員可以停止。" });
  }

  room.active = false;
  room.log.push({ ts: now(), type: "stop", by: interaction.user.id });

  pushHistoryIfEnded(room, { stoppedBy: interaction.user.id });
  deleteRoom(interaction.guildId, interaction.channelId);

  // ✅ 這裡也用「不會貼壞」的一行
  return safeEdit(interaction, { content: `✅ 已停止：${room.type}` });
}

/* ==============================
   Leaderboard / Rank helpers
================================ */

async function renderTop10Embed(guild, top) {
  const embed = new EmbedBuilder().setTitle("🏆 排行榜 Top 10").setDescription("（依積分排序）");

  if (!top || top.length === 0) {
    embed.setDescription("目前沒有資料。");
    return embed;
  }

  const lines = [];
  for (let i = 0; i < top.length; i++) {
    const row = top[i];
    const userId = row.userId || row.uid || row.id;
    const pts = row.points ?? row.value ?? row.score ?? 0;
    lines.push(`**${i + 1}.** <@${userId}> — **${pts}** 分`);
  }

  embed.setDescription(lines.join("\n"));
  return embed;
}

/* ==============================
   Public APIs for Admin Web
================================ */

function getRoomsSnapshot() {
  const arr = [];
  for (const r of rooms.values()) {
    arr.push({
      guildId: r.guildId,
      channelId: r.channelId,
      type: r.type,
      active: !!r.active,
      createdAt: r.createdAt,
      ownerId: r.ownerId,
      meta: r.meta,
      logCount: r.log.length,
      lastLog: r.log[r.log.length - 1] || null,
    });
  }
  return arr;
}

function getHistory7d() {
  // 回傳副本
  return history7d.slice(-200);
}

/* ==============================
   Main handlers
================================ */

async function handleInteraction(client, interaction) {
  try {
    // Slash Commands
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === "guess") return startGuess(interaction);
      if (name === "counting") return startCounting(interaction);
      if (name === "hl") return startHL(interaction);
      if (name === "stop") return stopAny(interaction);

      if (name === "rank") {
        if (!mustInGuild(interaction)) return;
        await safeDefer(interaction, false);

        // getTopPoints 你要做成走快取（你之前要求 /rank 秒回）
        const top = await getTopPoints(10);
        const embed = await renderTop10Embed(interaction.guild, top);
        return safeEdit(interaction, { embeds: [embed] });
      }

      return;
    }

    // Buttons
    if (interaction.isButton()) {
      const room = getRoom(interaction.guildId, interaction.channelId);

      // HL buttons
      if (interaction.customId === "hl_high" || interaction.customId === "hl_low" || interaction.customId === "hl_stop") {
        if (!room || room.type !== "hl") {
          return interaction.reply({ content: "⚠️ 本頻道沒有進行中的 HL。", ephemeral: true }).catch(() => {});
        }

        if (interaction.customId === "hl_stop") {
          // 房主/管理員可停
          const member = interaction.member;
          const isOwner = room.ownerId === interaction.user.id;
          const isAdmin = isAdminMember(member);
          if (!isOwner && !isAdmin) {
            return interaction.reply({ content: "❌ 只有開局者或管理員可以停止。", ephemeral: true }).catch(() => {});
          }
          return stopHLRoom(interaction, room, "manual_stop");
        }

        const pick = interaction.customId === "hl_high" ? "high" : "low";
        return handleHLButton(interaction, room, pick);
      }

      return;
    }
  } catch (e) {
    try {
      if (interaction && (interaction.deferred || interaction.replied)) {
        await interaction.editReply("❌ 發生錯誤，請稍後再試。");
      } else if (interaction) {
        await interaction.reply({ content: "❌ 發生錯誤，請稍後再試。", ephemeral: true });
      }
    } catch {}
    console.error("[Games] handleInteraction error:", e);
  }
}

async function handleMessage(client, msg) {
  try {
    if (!msg.guild || !msg.channel) return;
    if (msg.author?.bot) return;

    const room = getRoom(msg.guild.id, msg.channel.id);
    if (!room || !room.active) return;

    // ✅ 重要：counting / guess 不互相干擾
    if (room.type === "guess") return handleGuessMessage(msg, room);
    if (room.type === "counting") return handleCountingMessage(msg, room);

    // HL 只吃按鈕，不吃訊息
    return;
  } catch (e) {
    console.error("[Games] handleMessage error:", e);
  }
}

/* ==============================
   Slash Commands definition (optional)
   你可以在 registerCommands.js 用這個輸出
================================ */

const commands = [
  {
    name: "guess",
    description: "開始終極密碼（在本頻道）",
  },
  {
    name: "counting",
    description: "開始 Counting（在本頻道）",
  },
  {
    name: "hl",
    description: "開始高低牌（按鈕遊戲）",
  },
  {
    name: "stop",
    description: "停止本頻道進行中的遊戲",
  },
  {
    name: "rank",
    description: "查看排行榜",
  },
];

module.exports = {
  handleInteraction,
  handleMessage,

  // 給你的 web 後台用
  getRoomsSnapshot,
  getHistory7d,

  // 給註冊指令用（可選）
  commands,
};
