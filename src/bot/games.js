"use strict";

/**
 * src/bot/games.js
 * - counting：訊息輸入數字接龍
 * - guess：訊息輸入猜數字
 * - hl：按鈕式（預設 1~13，且開始就顯示底牌）
 *
 * 注意：這份是「可跑」的最小完整版本，先把你現在要的 1) 指令不重複 2) hl 改好。
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const pointsDb = require("../db/points.js");

// ---------- helpers ----------
function isIntString(s) {
  return typeof s === "string" && /^-?\d+$/.test(s.trim());
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------- COUNTING ----------
const countingState = new Map(); // channelId -> { active, expected, lastUserId }

function countingStart(channelId, start = 1) {
  countingState.set(channelId, {
    active: true,
    expected: start,
    lastUserId: null,
  });
}
function countingStop(channelId) {
  countingState.delete(channelId);
}
function countingStatus(channelId) {
  return countingState.get(channelId) || { active: false };
}

// ---------- GUESS ----------
const guessState = new Map(); // channelId -> { active, min, max, secret }

function guessSet(channelId, { min = 1, max = 100, secret }) {
  guessState.set(channelId, { active: true, min, max, secret });
}
function guessStart(channelId, { min = 1, max = 100 }) {
  const secret = randInt(min, max);
  guessState.set(channelId, { active: true, min, max, secret });
}
function guessStop(channelId) {
  guessState.delete(channelId);
}
function guessStatus(channelId) {
  return guessState.get(channelId) || { active: false };
}

// ---------- HL (High/Low card style) ----------
/**
 * 概念：從 1..max 抽牌
 * - 開始：先抽「底牌」current，直接顯示（你要求）
 * - 玩家按 Higher / Lower 來猜下一張是否更大/更小
 * - 猜對 +1 分，猜錯結束
 * - 單人簡化：只有按鈕的人能玩（避免群友亂按）
 */
const hlState = new Map(); // channelId -> { active, max, ownerId, current, score, messageId }

function hlStatus(channelId) {
  return hlState.get(channelId) || { active: false };
}
function hlStop(channelId) {
  hlState.delete(channelId);
}

async function hlStart(interaction, channelId, max = 13) {
  // ✅ 你要預設 1~13：commands.js 已給預設 13，這裡再保險一次
  max = Number.isFinite(max) ? max : 13;
  if (max < 2) max = 13;

  const ownerId = interaction.user.id;

  // 若已在同頻道進行中，直接提示
  const existing = hlState.get(channelId);
  if (existing?.active) {
    await interaction.channel.send("⚠️ 本頻道已有進行中的 HL，請先 /hl stop。");
    return;
  }

  // ✅ 開始就顯示底牌
  const current = randInt(1, max);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`hl:hi:${ownerId}`)
      .setLabel("更大 (Higher)")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`hl:lo:${ownerId}`)
      .setLabel("更小 (Lower)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`hl:stop:${ownerId}`)
      .setLabel("結束")
      .setStyle(ButtonStyle.Danger)
  );

  const msg = await interaction.channel.send({
    content: `🂠 **HL 開始！**（範圍 1~${max}）\n✅ **底牌是：${current}**\n請按按鈕猜「下一張」會更大或更小。（只有 <@${ownerId}> 能操作）`,
    components: [row],
  });

  hlState.set(channelId, {
    active: true,
    max,
    ownerId,
    current,
    score: 0,
    messageId: msg.id,
  });
}

// ---------- message handler ----------
async function onMessage(message) {
  const channelId = message.channel.id;

  // counting：非數字直接忽略（你之後要「非數字刪除＋警告」我們下一步再加）
  const cs = countingState.get(channelId);
  if (cs?.active) {
    if (!isIntString(message.content)) return;

    const n = parseInt(message.content.trim(), 10);

    // 同一人連打兩次
    if (cs.lastUserId === message.author.id) {
      countingState.delete(channelId);
      await message.channel.send(`💥 <@${message.author.id}> 連打兩次！counting 結束。`);
      return;
    }

    // 打錯
    if (n !== cs.expected) {
      countingState.delete(channelId);
      await message.channel.send(
        `💥 <@${message.author.id}> 打錯了！應該是 **${cs.expected}**，counting 結束。`
      );
      return;
    }

    // 正確
    cs.lastUserId = message.author.id;
    cs.expected += 1;

    // 給一點點分（可自行調整）
    if (pointsDb?.addPoints) {
      await pointsDb.addPoints(message.author.id, 1).catch(() => {});
    }

    return;
  }

  // guess：只吃數字
  const gs = guessState.get(channelId);
  if (gs?.active) {
    if (!isIntString(message.content)) return;

    const n = parseInt(message.content.trim(), 10);

    if (n <= gs.min || n >= gs.max) {
      // 範圍外：提醒但不結束
      await message.channel.send(`⛔ 範圍是 **${gs.min} ~ ${gs.max}**（不含邊界），請再猜。`);
      return;
    }

    if (n === gs.secret) {
      guessState.delete(channelId);
      await message.channel.send(`🎉 <@${message.author.id}> 猜中了！密碼就是 **${n}**（+10 分）`);
      if (pointsDb?.addPoints) {
        await pointsDb.addPoints(message.author.id, 10).catch(() => {});
      }
      return;
    }

    // 收斂範圍
    if (n < gs.secret) gs.min = n;
    else gs.max = n;

    await message.channel.send(`🔎 新範圍：**${gs.min} ~ ${gs.max}**`);
    return;
  }
}

// ---------- interaction handler for HL buttons ----------
async function onInteraction(interaction) {
  if (!interaction.isButton()) return;

  const [game, action, ownerId] = interaction.customId.split(":");
  if (game !== "hl") return;

  // 只允許房主操作
  if (interaction.user.id !== ownerId) {
    try {
      await interaction.reply({ content: "❌ 這不是你的 HL。", ephemeral: true });
    } catch (_) {}
    return;
  }

  const channelId = interaction.channelId;
  const st = hlState.get(channelId);
  if (!st?.active) {
    try {
      await interaction.reply({ content: "ℹ️ 這局 HL 已結束。", ephemeral: true });
    } catch (_) {}
    return;
  }

  if (action === "stop") {
    hlState.delete(channelId);
    try {
      await interaction.update({ components: [] });
    } catch (_) {}
    await interaction.channel.send(`🛑 HL 結束。<@${ownerId}> 本局得分：**${st.score}**`);
    return;
  }

  // 抽下一張
  const next = randInt(1, st.max);
  const prev = st.current;

  let ok = false;
  if (action === "hi") ok = next > prev;
  if (action === "lo") ok = next < prev;

  if (ok) st.score += 1;

  st.current = next;

  if (!ok) {
    hlState.delete(channelId);

    // 關按鈕
    try {
      await interaction.update({ components: [] });
    } catch (_) {}

    await interaction.channel.send(
      `💥 猜錯！上一張 **${prev}**，下一張 **${next}**。\n🛑 HL 結束。<@${ownerId}> 本局得分：**${st.score}**`
    );
    return;
  }

  // 猜對：繼續顯示底牌（現在的牌）
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`hl:hi:${ownerId}`)
      .setLabel("更大 (Higher)")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`hl:lo:${ownerId}`)
      .setLabel("更小 (Lower)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`hl:stop:${ownerId}`)
      .setLabel("結束")
      .setStyle(ButtonStyle.Danger)
  );

  try {
    await interaction.update({
      content: `🂠 HL 進行中（1~${st.max}）\n✅ 目前底牌：**${st.current}**\n分數：**${st.score}**`,
      components: [row],
    });
  } catch (_) {}
}

// 把 button handler 掛在 exports，讓 index.js 也可以加（如果你想）
const games = {
  countingStart,
  countingStop,
  countingStatus,

  guessSet,
  guessStart,
  guessStop,
  guessStatus,

  hlStart,
  hlStop,
  hlStatus,
};

module.exports = {
  games,
  onMessage,
  onInteraction,
};