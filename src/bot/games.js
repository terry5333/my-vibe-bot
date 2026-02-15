"use strict";

/**
 * games.js (FULL SAFE VERSION)
 * - Guess / Counting / HL
 * - Firebase Logs
 * - Points
 * - Anti-conflict
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require("discord.js");

const { getDB } = require("../db/firebase");
const { addPoints } = require("../db/points");
const {
  upsertUserProfile,
  setActiveRoom,
  clearActiveRoom,
  appendRoomEvent,
  pushRoomEventRolling,
} = require("../db/logs");

/* ================= Utils ================= */

function now() {
  return Date.now();
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isInt(t) {
  return /^-?\d+$/.test(t);
}

/* ================= In-Memory States ================= */

const guessGame = new Map();      // channelId
const countingGame = new Map();   // channelId
const hlGame = new Map();         // userId

const STOP_BLOCK_MS = 60000;
const stopped = new Map();        // channelId => ts

/* ================= User Sync ================= */

async function syncUser(user) {
  try {
    await upsertUserProfile(user.id, {
      name: user.username,
      avatar: user.displayAvatarURL(),
    });
  } catch {}
}

/* ================= Guess ================= */

async function onGuess(client, interaction) {
  await interaction.deferReply();

  const channelId = interaction.channelId;
  const guildId = interaction.guildId;

  if (countingGame.get(channelId)) {
    return interaction.editReply("❌ 此頻道正在進行 Counting。");
  }

  if (guessGame.get(channelId)) {
    return interaction.editReply("❌ 已有 Guess 進行中。");
  }

  const min = interaction.options.getInteger("min") ?? 1;
  const max = interaction.options.getInteger("max") ?? 100;

  const a = Math.min(min, max);
  const b = Math.max(min, max);

  const answer = rand(a + 1, b - 1);

  const roomId = await setActiveRoom("guess", {
    guildId,
    key: channelId,
    channelId,
    title: "Guess",
    state: { min: a, max: b },
  });

  guessGame.set(channelId, {
    min: a,
    max: b,
    answer,
    roomId,
  });

  await appendRoomEvent("guess", guildId, channelId, {
    type: "start",
    min: a,
    max: b,
  });

  interaction.editReply(`🎯 Guess 開始！範圍 ${a} ~ ${b}`);
}

/* ================= Counting ================= */

async function onCounting(client, interaction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();
  const channelId = interaction.channelId;
  const guildId = interaction.guildId;

  if (sub === "start") {
    if (guessGame.get(channelId)) {
      return interaction.editReply("❌ 有 Guess 進行中。");
    }

    const start = interaction.options.getInteger("start") ?? 1;
    const reward = interaction.options.getInteger("reward") ?? 1;

    const roomId = await setActiveRoom("counting", {
      guildId,
      key: channelId,
      channelId,
      title: "Counting",
      state: { start, reward },
    });

    countingGame.set(channelId, {
      next: start,
      last: null,
      reward,
      roomId,
      guildId,
    });

    stopped.delete(channelId);

    await appendRoomEvent("counting", guildId, channelId, {
      type: "start",
      start,
      reward,
    });

    await interaction.channel.send(`🔢 Counting 開始：${start}`);
    interaction.editReply("✅ 已啟動");
  }

  if (sub === "stop") {
    const cur = countingGame.get(channelId);
    countingGame.delete(channelId);
    stopped.set(channelId, now());

    if (cur) {
      await clearActiveRoom("counting", guildId, channelId);
      await appendRoomEvent("counting", guildId, channelId, {
        type: "stop",
        by: interaction.user.id,
      });
    }

    await interaction.channel.send("🛑 Counting 已停止");
    interaction.editReply("✅ 已停止");
  }

  if (sub === "status") {
    const c = countingGame.get(channelId);
    if (!c) return interaction.editReply("❌ 沒有進行中");

    interaction.editReply(`下一個：${c.next}`);
  }
}

/* ================= HL ================= */

function hlButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("hl:up")
        .setLabel("更大")
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId("hl:down")
        .setLabel("更小")
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId("hl:stop")
        .setLabel("結束")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function onHL(client, interaction) {
  await interaction.deferReply();

  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  if (hlGame.get(userId)) {
    return interaction.editReply("❌ 你已經在玩 HL");
  }

  const cur = rand(1, 13);

  const roomId = await setActiveRoom("hl", {
    guildId,
    key: userId,
    userId,
    title: "HL",
    state: { cur },
  });

  hlGame.set(userId, {
    cur,
    streak: 0,
    roomId,
    guildId,
  });

  await appendRoomEvent("hl", guildId, userId, {
    type: "start",
    cur,
  });

  interaction.editReply({
    content: `🃏 目前牌：${cur}`,
    components: hlButtons(),
  });
}

/* ================= Message Handler ================= */

async function onMessage(client, msg) {
  if (!msg.guild) return;
  if (msg.author.bot) return;

  await syncUser(msg.author);

  const channelId = msg.channel.id;
  const guildId = msg.guild.id;
  const text = msg.content.trim();

  /* ---- Guess ---- */

  const g = guessGame.get(channelId);

  if (g && isInt(text)) {
    const n = Number(text);

    if (n === g.answer) {
      guessGame.delete(channelId);
      await clearActiveRoom("guess", guildId, channelId);

      let total = null;

      try {
        total = await addPoints(msg.author.id, 50);
      } catch {}

      await msg.reply(`🎉 猜中！+50 分（${total ?? "失敗"}）`);

      await appendRoomEvent("guess", guildId, channelId, {
        type: "win",
        user: msg.author.id,
        value: n,
        total,
      });

      return;
    }

    if (n < g.answer) g.min = n;
    if (n > g.answer) g.max = n;

    msg.reply(`範圍：${g.min} ~ ${g.max}`);
    return;
  }

  /* ---- Stop block ---- */

  const st = stopped.get(channelId);
  if (st && now() - st < STOP_BLOCK_MS) return;

  /* ---- Counting ---- */

  const c = countingGame.get(channelId);

  if (c && isInt(text)) {
    const n = Number(text);

    if (c.last === msg.author.id) {
      msg.reply("⛔ 不可連續");
      return;
    }

    if (n !== c.next) {
      c.next = 1;
      c.last = null;

      msg.reply("❌ 錯誤，重來 1");
      return;
    }

    c.last = msg.author.id;
    c.next++;

    let total = null;

    try {
      total = await addPoints(msg.author.id, c.reward);
    } catch {}

    msg.react("✅");
    msg.reply(`+${c.reward} 分（${total ?? "失敗"}）`);

    await appendRoomEvent("counting", guildId, channelId, {
      type: "ok",
      user: msg.author.id,
      value: n,
      total,
    });
  }
}

/* ================= Buttons ================= */

async function onButton(client, interaction) {
  const id = interaction.customId;

  if (!id.startsWith("hl:")) return;

  const userId = interaction.user.id;
  const s = hlGame.get(userId);

  if (!s) {
    return interaction.reply({ content: "❌ 無進行中 HL", ephemeral: true });
  }

  if (id === "hl:stop") {
    hlGame.delete(userId);
    await clearActiveRoom("hl", s.guildId, userId);

    return interaction.update({
      content: `🛑 結束，連勝 ${s.streak}`,
      components: [],
    });
  }

  const next = rand(1, 13);

  const ok =
    (id === "hl:up" && next > s.cur) ||
    (id === "hl:down" && next < s.cur);

  if (!ok) {
    hlGame.delete(userId);
    await clearActiveRoom("hl", s.guildId, userId);

    return interaction.update({
      content: `❌ 失敗 ${s.cur} → ${next}`,
      components: [],
    });
  }

  s.cur = next;
  s.streak++;

  let total = null;

  try {
    total = await addPoints(userId, 5);
  } catch {}

  interaction.update({
    content: `✅ 正確！${next}｜連勝 ${s.streak}（${total ?? "失敗"}）`,
    components: hlButtons(),
  });
}

/* ================= Force Stop ================= */

async function forceStopGuess(guildId, channelId) {
  guessGame.delete(channelId);
  await clearActiveRoom("guess", guildId, channelId);
}

async function forceStopCounting(guildId, channelId) {
  countingGame.delete(channelId);
  stopped.set(channelId, now());
  await clearActiveRoom("counting", guildId, channelId);
}

async function forceStopHL(guildId, userId) {
  hlGame.delete(userId);
  await clearActiveRoom("hl", guildId, userId);
}

/* ================= Exports ================= */

module.exports = {
  guessGame,
  countingGame,
  hlGame,

  onGuessCommand: onGuess,
  onCountingCommand: onCounting,
  onHLCommand: onHL,

  onMessageCreate: onMessage,
  onButton,

  forceStopGuess,
  forceStopCounting,
  forceStopHL,

  syncUser,
};
