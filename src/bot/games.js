"use strict";

/**
 * games.js
 * - counting：聊天室數字接龍（✅ 表情符號，✅ 打錯只回一次，✅ 打字兩次 -> 警告）
 * - guess：聊天室猜數字
 * - hl：按鈕式（✅ 預設 1~13，✅ 顯示底牌，✅ 可無限玩直到 stop）
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const points = require("./points");
const system = require("./system");
const { writeState } = require("./storage");

// ---------- helpers ----------
function isIntString(s) {
  return typeof s === "string" && /^-?\d+$/.test(s.trim());
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------- COUNTING ----------
const countingState = new Map(); // channelId -> { active, expected, lastUserId, ended }

function countingStart(channelId, start = 1) {
  countingState.set(channelId, { active: true, expected: start, lastUserId: null, ended: false });
}
function countingStop(channelId) {
  countingState.delete(channelId);
}
function countingStatus(channelId) {
  return countingState.get(channelId) || { active: false };
}

// 警告：counting 打文字次數（只在 counting 頻道用）
const countingTextStrike = new Map(); // userId -> count

async function applyWarn(guild, member) {
  if (!guild || !member) return;
  if (member.permissions.has("Administrator")) return;

  const s = system.sysState();
  const warnRoleId = s.system?.warnRoleId;
  const permRoleId = s.system?.warnPermRoleId;

  // 若已永久就不處理
  if (permRoleId && member.roles.cache.has(permRoleId)) return;

  const existing = s.warn?.[member.id];
  if (existing?.perm) return;

  // 若之前曾被警告過 -> 這次直接永久
  if (existing?.hadBefore) {
    if (permRoleId) await member.roles.add(permRoleId).catch(() => {});
    s.warn[member.id] = { perm: true, at: Date.now() };
    writeState(s);
    return;
  }

  // 第一次：3天
  const until = Date.now() + 3 * 24 * 60 * 60 * 1000;
  if (warnRoleId) await member.roles.add(warnRoleId).catch(() => {});
  s.warn[member.id] = { until, hadBefore: true };
  writeState(s);
}

async function onMessage(message) {
  const channelId = message.channel.id;
  const ids = system.getSystemIds();

  // ===== COUNTING（只在 counting 大廳執行）=====
  const isCountingChannel = ids.countingLobbyId && channelId === ids.countingLobbyId;
  const cs = countingState.get(channelId);

  // counting 頻道：文字處理（即使沒開始也處理規則：非數字刪除 + 警告）
  if (isCountingChannel) {
    if (!isIntString(message.content)) {
      await message.delete().catch(() => {});
      const strikes = (countingTextStrike.get(message.author.id) || 0) + 1;
      countingTextStrike.set(message.author.id, strikes);

      // 私訊提醒
      await message.author.send(`⚠️ Counting 只能輸入數字（你已違規 ${strikes} 次）。`).catch(() => {});

      if (strikes >= 2) {
        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (member) await applyWarn(message.guild, member);
        await message.author.send("⛔ 你已被警告（賤人），3 天內不能玩遊戲房間。再犯將永久。").catch(() => {});
      }
      return;
    }
  }

  // counting 遊戲進行
  if (cs?.active) {
    if (!isIntString(message.content)) return; // 理論上 counting 頻道已經刪了

    const n = parseInt(message.content.trim(), 10);

    // 同一人連打兩次
    if (cs.lastUserId === message.author.id) {
      if (cs.ended) return;
      cs.ended = true;
      countingState.delete(channelId);
      await message.react("💥").catch(() => {});
      await message.channel.send(`💥 <@${message.author.id}> 連打兩次！🟥 Counting 結束。`).catch(() => {});
      return;
    }

    // 打錯
    if (n !== cs.expected) {
      if (cs.ended) return;
      cs.ended = true;
      countingState.delete(channelId);
      await message.react("❌").catch(() => {});
      await message.channel
        .send(`❌ <@${message.author.id}> 打錯了！應該是 **${cs.expected}**\n🟥 Counting 結束。`)
        .catch(() => {});
      return;
    }

    // 正確
    cs.lastUserId = message.author.id;
    cs.expected += 1;

    await message.react("✅").catch(() => {});
    points.addPoints(message.author.id, 2);
    return;
  }

  // ===== GUESS =====
  const gs = guessState.get(channelId);
  if (gs?.active) {
    if (!isIntString(message.content)) return;

    const n = parseInt(message.content.trim(), 10);

    if (n <= gs.min || n >= gs.max) {
      await message.channel.send(`⛔ 範圍是 **${gs.min} ~ ${gs.max}**（不含邊界），請再猜。`).catch(() => {});
      return;
    }

    if (n === gs.secret) {
      guessState.delete(channelId);
      points.addPoints(message.author.id, 10);
      await message.channel.send(`🎉 <@${message.author.id}> 猜中了！密碼就是 **${n}**（+10 分）`).catch(() => {});
      // 結束就關房（讓 system 處理關房）
      await system.forceCloseRoom(channelId, gs.ownerId || null, message.client, "Guess 結束").catch(() => {});
      return;
    }

    if (n < gs.secret) gs.min = n;
    else gs.max = n;

    await message.channel.send(`🔎 新範圍：**${gs.min} ~ ${gs.max}**`).catch(() => {});
    return;
  }
}

// ---------- GUESS ----------
const guessState = new Map(); // channelId -> { active, min, max, secret, ownerId }

function guessStart(channelId, { min = 1, max = 100, ownerId = null }) {
  const secret = randInt(min, max);
  guessState.set(channelId, { active: true, min, max, secret, ownerId });
}
function guessStop(channelId) {
  guessState.delete(channelId);
}

// ---------- HL ----------
const hlState = new Map(); // channelId -> { active, max, ownerId, current, score }

function hlStop(channelId) {
  hlState.delete(channelId);
}

async function hlStart(interaction, channelId, max = 13) {
  max = Number.isFinite(max) ? max : 13;
  if (max < 2) max = 13;

  const ownerId = interaction.user.id;

  const existing = hlState.get(channelId);
  if (existing?.active) {
    await interaction.channel.send("⚠️ 本頻道已有進行中的 HL。").catch(() => {});
    return;
  }

  const current = randInt(1, max);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hl:hi:${ownerId}`).setLabel("更大 (Higher)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`hl:lo:${ownerId}`).setLabel("更小 (Lower)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hl:stop:${ownerId}`).setLabel("Stop").setStyle(ButtonStyle.Danger)
  );

  await interaction.channel
    .send({
      content: `🂠 **HL 開始！**（1~${max}）\n✅ **底牌：${current}**\n按按鈕猜下一張。（只有 <@${ownerId}> 能操作）`,
      components: [row],
    })
    .catch(() => {});

  hlState.set(channelId, { active: true, max, ownerId, current, score: 0 });
}

async function onInteraction(interaction) {
  if (!interaction.isButton()) return;

  const [game, action, ownerId] = interaction.customId.split(":");
  if (game !== "hl") return;

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "❌ 這不是你的 HL。", ephemeral: true }).catch(() => {});
    return;
  }

  const channelId = interaction.channelId;
  const st = hlState.get(channelId);
  if (!st?.active) {
    await interaction.reply({ content: "ℹ️ 這局 HL 已結束。", ephemeral: true }).catch(() => {});
    return;
  }

  if (action === "stop") {
    hlState.delete(channelId);
    await interaction.update({ components: [] }).catch(() => {});
    await interaction.channel.send(`🛑 HL 已停止。<@${ownerId}> 本次總得分：**${st.score}**`).catch(() => {});
    // stop -> 關房
    await system.forceCloseRoom(channelId, ownerId, interaction.client, "HL stop").catch(() => {});
    return;
  }

  // 抽下一張
  const next = randInt(1, st.max);
  const prev = st.current;

  let ok = false;
  if (action === "hi") ok = next > prev;
  if (action === "lo") ok = next < prev;

  // ✅ 無限多局：猜錯不結束，直接開新一局（底牌變 next）
  if (ok) {
    st.score += 1;
    points.addPoints(ownerId, 5); // 每次猜對 +5 分
    st.current = next;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`hl:hi:${ownerId}`).setLabel("更大 (Higher)").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`hl:lo:${ownerId}`).setLabel("更小 (Lower)").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`hl:stop:${ownerId}`).setLabel("Stop").setStyle(ButtonStyle.Danger)
    );

    await interaction
      .update({
        content: `✅ 猜對！上一張 **${prev}** → 下一張 **${next}**\n🂠 目前底牌：**${st.current}**（1~${st.max}）\n分數：**${st.score}**（每次猜對 +5 分）`,
        components: [row],
      })
      .catch(() => {});
    return;
  }

  // 猜錯：提示結果，但不關閉、不停，直接把 next 當新底牌繼續
  st.current = next;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`hl:hi:${ownerId}`).setLabel("更大 (Higher)").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`hl:lo:${ownerId}`).setLabel("更小 (Lower)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`hl:stop:${ownerId}`).setLabel("Stop").setStyle(ButtonStyle.Danger)
  );

  await interaction
    .update({
      content: `❌ 猜錯！上一張 **${prev}** → 下一張 **${next}**\n🂠 新底牌：**${st.current}**（繼續玩到按 Stop）\n目前分數：**${st.score}**`,
      components: [row],
    })
    .catch(() => {});
}

const games = {
  countingStart,
  countingStop,
  countingStatus,
  guessStart,
  guessStop,
  hlStart,
  hlStop,
};

module.exports = { games, onMessage, onInteraction };