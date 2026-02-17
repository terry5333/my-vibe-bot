"use strict";

/**
 * src/bot/games.js
 * - counting：訊息輸入數字接龍（playing/paused/stopped）
 * - guess：訊息輸入猜數字
 * - hl：按鈕式 high/low
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");
const pointsDb = require("../db/points.js");

// ---------- helpers ----------
function isIntString(s) {
  return typeof s === "string" && /^-?\d+$/.test(s.trim());
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// message dedupe (same process)
const handledMessageIds = new Set();
function markMessageHandled(id) {
  if (handledMessageIds.has(id)) return false;
  handledMessageIds.add(id);
  if (handledMessageIds.size > 8000) handledMessageIds.clear();
  return true;
}

// ---------- COUNTING ----------
/**
 * channelId -> {
 *   state: 'playing' | 'paused' | 'stopped',
 *   expected: number,
 *   lastUserId: string|null
 * }
 */
const countingState = new Map();

function countingEnsure(channelId) {
  if (!countingState.has(channelId)) {
    countingState.set(channelId, { state: "stopped", expected: 1, lastUserId: null });
  }
  return countingState.get(channelId);
}

function countingStart(channelId, start = 1) {
  countingState.set(channelId, { state: "playing", expected: start, lastUserId: null });
}

function countingPause(channelId) {
  const st = countingEnsure(channelId);
  st.state = "paused";
}

function countingStop(channelId) {
  const st = countingEnsure(channelId);
  st.state = "stopped";
  st.expected = 1;
  st.lastUserId = null;
}

function countingStatus(channelId) {
  return countingEnsure(channelId);
}

// 用「頻道名稱」辨識 counting 大廳（重啟也不怕）
function isCountingLobbyChannel(message) {
  // 你現在 counting lobby 叫 "🟩-counting"
  return message?.channel?.name === "🟩-counting";
}

// 發提示訊息（自動 3 秒刪）
async function sendTemp(channel, content, ms = 3000) {
  const m = await channel.send(content).catch(() => null);
  if (!m) return;
  setTimeout(() => m.delete().catch(() => {}), ms);
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

// ---------- HL ----------
const hlState = new Map(); // channelId -> { active, max, ownerId, current, score }

function hlStatus(channelId) {
  return hlState.get(channelId) || { active: false };
}
function hlStop(channelId) {
  hlState.delete(channelId);
}

async function hlStart(interaction, channelId, max = 13) {
  max = Number.isFinite(max) ? max : 13;
  if (max < 2) max = 13;

  const ownerId = interaction.user.id;

  const existing = hlState.get(channelId);
  if (existing?.active) {
    await interaction.channel.send("⚠️ 本頻道已有進行中的 HL。");
    return;
  }

  const current = randInt(1, max);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hl:hi:${ownerId}`).setLabel("更大 (Higher)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`hl:lo:${ownerId}`).setLabel("更小 (Lower)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hl:stop:${ownerId}`).setLabel("結束").setStyle(ButtonStyle.Danger)
  );

  await interaction.channel.send({
    content: `🂠 **HL 開始！**（1~${max}）\n✅ **底牌：${current}**\n請按按鈕猜下一張更大/更小。（只有 <@${ownerId}> 能操作）`,
    components: [row],
  });

  hlState.set(channelId, { active: true, max, ownerId, current, score: 0 });
}

// ---------- message handler ----------
async function onMessage(message) {
  if (!markMessageHandled(message.id)) return;

  const channelId = message.channel.id;

  // ===== COUNTING lobby：非 playing -> 全刪 + 提示 =====
  if (isCountingLobbyChannel(message)) {
    const st = countingStatus(channelId);

    if (st.state !== "playing") {
      await message.delete().catch(() => {});
      await sendTemp(message.channel, "⛔ **Counting 尚未開始**，請等待管理員按下「開始」。");
      return;
    }

    // playing 狀態才允許訊息存在
    if (!isIntString(message.content)) {
      // playing 但不是數字：刪除並提示
      await message.delete().catch(() => {});
      await sendTemp(message.channel, "⚠️ Counting 進行中只能輸入數字。");
      return;
    }

    const n = parseInt(message.content.trim(), 10);

    // 同一人連打兩次
    if (st.lastUserId === message.author.id) {
      st.state = "stopped";
      await message.channel.send(`💥 <@${message.author.id}> 連打兩次！Counting 結束。`);
      return;
    }

    // 打錯
    if (n !== st.expected) {
      st.state = "stopped";
      await message.channel.send(`💥 <@${message.author.id}> 打錯了！應該是 **${st.expected}**，Counting 結束。`);
      return;
    }

    // 正確 ✅
    st.lastUserId = message.author.id;
    st.expected += 1;

    // 加分
    if (pointsDb?.addPoints) {
      await pointsDb.addPoints(message.author.id, 1).catch(() => {});
    }

    return;
  }

  // ===== GUESS：只吃數字 =====
  const gs = guessState.get(channelId);
  if (gs?.active) {
    if (!isIntString(message.content)) return;

    const n = parseInt(message.content.trim(), 10);

    if (n <= gs.min || n >= gs.max) {
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

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "❌ 這不是你的 HL。", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const channelId = interaction.channelId;
  const st = hlState.get(channelId);
  if (!st?.active) {
    await interaction.reply({ content: "ℹ️ 這局 HL 已結束。", flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  if (action === "stop") {
    hlState.delete(channelId);
    await interaction.update({ components: [] }).catch(() => {});
    await interaction.channel.send(`🛑 HL 結束。<@${ownerId}> 本局得分：**${st.score}**`);
    return;
  }

  const next = randInt(1, st.max);
  const prev = st.current;

  let ok = false;
  if (action === "hi") ok = next > prev;
  if (action === "lo") ok = next < prev;

  if (ok) st.score += 1;
  st.current = next;

  if (!ok) {
    hlState.delete(channelId);
    await interaction.update({ components: [] }).catch(() => {});
    await interaction.channel.send(`💥 猜錯！上一張 **${prev}**，下一張 **${next}**。\n🛑 HL 結束。得分：**${st.score}**`);
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hl:hi:${ownerId}`).setLabel("更大 (Higher)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`hl:lo:${ownerId}`).setLabel("更小 (Lower)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hl:stop:${ownerId}`).setLabel("結束").setStyle(ButtonStyle.Danger)
  );

  await interaction.update({
    content: `🂠 HL 進行中（1~${st.max}）\n✅ 目前底牌：**${st.current}**\n⭐ 分數：**${st.score}**`,
    components: [row],
  }).catch(() => {});
}

// exports
const games = {
  countingStart,
  countingPause,
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

module.exports = { games, onMessage, onInteraction };