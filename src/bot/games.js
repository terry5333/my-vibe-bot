"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

const pointsDb = require("../db/points.js");

// ---------- util ----------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function rankText(r) {
  if (r === 1) return "A";
  if (r === 11) return "J";
  if (r === 12) return "Q";
  if (r === 13) return "K";
  return String(r);
}

const SUITS = ["♠️", "♥️", "♦️", "♣️"];

function cardToText(card) {
  return `${SUITS[card.suit]} ${rankText(card.rank)}`;
}

// ---------- HL state ----------
const hlStates = new Map(); // channelId -> { active, max, deck, current, messageId, starterId }

function buildHlMessage(state) {
  const e = new EmbedBuilder()
    .setTitle("🃏 HL Higher / Lower")
    .setDescription(
      [
        `底牌：**${cardToText(state.current)}**`,
        `範圍：1 ~ ${state.max}`,
        "",
        "按按鈕猜下一張：Higher / Lower",
      ].join("\n")
    )
    .setFooter({ text: `剩餘牌數：${state.deck.length}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`hl:${state.channelId}:high`)
      .setLabel("Higher")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`hl:${state.channelId}:low`)
      .setLabel("Lower")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`hl:${state.channelId}:stop`)
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [e], components: [row] };
}

function buildHlEndedMessage(state, note) {
  const e = new EmbedBuilder()
    .setTitle("🛑 HL 結束")
    .setDescription(note || "遊戲已結束。")
    .addFields(
      { name: "最後底牌", value: `**${cardToText(state.current)}**`, inline: true },
      { name: "剩餘牌數", value: String(state.deck.length), inline: true }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("hl:disabled:high").setLabel("Higher").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId("hl:disabled:low").setLabel("Lower").setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId("hl:disabled:stop").setLabel("Stop").setStyle(ButtonStyle.Danger).setDisabled(true)
  );

  return { embeds: [e], components: [row] };
}

async function addPointsSafe(userId, delta) {
  try {
    if (pointsDb?.addPoints) await pointsDb.addPoints(userId, delta);
  } catch (_) {}
}

// ---------- exported games ----------
const games = {
  // ---- HL ----
  async hlStart(interaction, channelId, max = 13) {
    const m = Math.min(13, Math.max(2, max)); // 至少 2，最多 13
    const deck = [];
    for (let r = 1; r <= m; r++) {
      for (let s = 0; s < 4; s++) deck.push({ rank: r, suit: s });
    }
    shuffle(deck);

    const current = deck.pop(); // ✅ 一開始就亮底牌
    const state = {
      active: true,
      channelId,
      max: m,
      deck,
      current,
      messageId: null,
      starterId: interaction.user.id,
    };

    hlStates.set(channelId, state);

    const payload = buildHlMessage(state);
    const msg = await interaction.channel.send(payload);
    state.messageId = msg.id;
  },

  hlStop(channelId) {
    hlStates.delete(channelId);
  },

  hlStatus(channelId) {
    const s = hlStates.get(channelId);
    if (!s?.active) return { active: false };
    return {
      active: true,
      max: s.max,
      remaining: s.deck.length,
      currentText: cardToText(s.current),
    };
  },
};

// ---------- interaction handler (buttons) ----------
async function onInteraction(interaction) {
  if (!interaction.isButton()) return;

  const id = interaction.customId || "";
  if (!id.startsWith("hl:")) return;

  // 先 ack update（避免 Unknown interaction）
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  } catch (_) {}

  const parts = id.split(":");
  // hl:<channelId>:<action>
  const channelId = parts[1];
  const action = parts[2];

  if (!channelId || !action) return;

  // 防跨頻道亂按
  if (interaction.channelId !== channelId) {
    try {
      await interaction.followUp({ content: "❌ 這個按鈕不是本頻道的 HL。", flags: MessageFlags.Ephemeral });
    } catch (_) {}
    return;
  }

  const state = hlStates.get(channelId);
  if (!state?.active) {
    try {
      await interaction.followUp({ content: "ℹ️ 這局 HL 已經結束了。", flags: MessageFlags.Ephemeral });
    } catch (_) {}
    return;
  }

  // 如果按的不是那一則 HL 訊息也忽略（避免多局混在一起）
  if (state.messageId && interaction.message?.id && state.messageId !== interaction.message.id) return;

  if (action === "stop") {
    // 只有管理員或開局者可 stop（你要改規則也可以）
    const isStarter = interaction.user.id === state.starterId;
    const perms = interaction.memberPermissions;
    const isAdmin =
      perms?.has?.(require("discord.js").PermissionFlagsBits.Administrator) ||
      perms?.has?.(require("discord.js").PermissionFlagsBits.ManageGuild);

    if (!isStarter && !isAdmin) {
      try {
        await interaction.followUp({ content: "❌ 只有開局者或管理員可以 Stop。", flags: MessageFlags.Ephemeral });
      } catch (_) {}
      return;
    }

    state.active = false;
    hlStates.delete(channelId);
    const ended = buildHlEndedMessage(state, "已手動結束。");
    try { await interaction.message.edit(ended); } catch (_) {}
    return;
  }

  if (state.deck.length <= 0) {
    state.active = false;
    hlStates.delete(channelId);
    const ended = buildHlEndedMessage(state, "牌已抽完，結束！");
    try { await interaction.message.edit(ended); } catch (_) {}
    return;
  }

  // 抽下一張
  const next = state.deck.pop();
  const prevRank = state.current.rank;
  const nextRank = next.rank;

  const guessHigh = action === "high";
  const guessLow = action === "low";

  // 規則：相等算輸（你要相等算贏也能改）
  const isWin =
    (guessHigh && nextRank > prevRank) ||
    (guessLow && nextRank < prevRank);

  const desc = [
    `底牌：**${cardToText(state.current)}**`,
    `下一張：**${cardToText(next)}**`,
    "",
    isWin ? "✅ 你猜對了！+1 分" : "❌ 你猜錯了，遊戲結束！",
  ].join("\n");

  if (isWin) {
    state.current = next;

    // 給分（你要不要分數都行）
    await addPointsSafe(interaction.user.id, 1);

    const payload = buildHlMessage(state);
    payload.embeds[0].setDescription(desc);
    try { await interaction.message.edit(payload); } catch (_) {}
  } else {
    state.active = false;
    hlStates.delete(channelId);

    await interaction.message.edit(buildHlEndedMessage(
      { ...state, current: next },
      desc
    )).catch(() => {});
  }
}

// ---------- message handler（給 counting/guess 用；你若沒用可留著） ----------
async function onMessage(message) {
  // 這份只放空殼避免你原本專案爆炸；你原本 counting/guess 如果已有就保留你自己的
}

module.exports = { games, onInteraction, onMessage };