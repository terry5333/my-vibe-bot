"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const pointsDb = require("../db/points");

// ===== helpers =====
function isIntString(s) {
  return typeof s === "string" && /^\d+$/.test(s.trim());
}
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/* =========================================================
   COUNTING
========================================================= */

const countingState = new Map();

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

/* =========================================================
   GUESS
========================================================= */

const guessState = new Map();

function guessStart(channelId, { min = 1, max = 100 }) {
  guessState.set(channelId, {
    active: true,
    min,
    max,
    secret: rand(min, max),
  });
}

function guessStop(channelId) {
  guessState.delete(channelId);
}

/* =========================================================
   HL
========================================================= */

const hlState = new Map();

function hlStop(channelId) {
  hlState.delete(channelId);
}

async function hlStart(fakeInteraction, channelId, max = 13) {
  const ownerId = fakeInteraction.user.id;

  hlState.set(channelId, {
    active: true,
    max,
    ownerId,
    current: rand(1, max),
    score: 0,
  });

  const st = hlState.get(channelId);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`hl:hi:${ownerId}`)
      .setLabel("更大")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`hl:lo:${ownerId}`)
      .setLabel("更小")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`hl:stop:${ownerId}`)
      .setLabel("停止")
      .setStyle(ButtonStyle.Danger)
  );

  await fakeInteraction.channel.send({
    content: `🂠 HL 開始！\n底牌是：**${st.current}**`,
    components: [row],
  });
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function onMessage(message) {
  const channelId = message.channel.id;

  /* ---------------- COUNTING ---------------- */

  const cs = countingState.get(channelId);
  if (cs?.active) {
    if (!isIntString(message.content)) return;

    const n = parseInt(message.content);

    // 連續兩次
    if (cs.lastUserId === message.author.id) {
      countingState.delete(channelId);
      await message.channel.send("💥 同一人不能連續兩次！遊戲結束！");
      return;
    }

    // 打錯
    if (n !== cs.expected) {
      countingState.delete(channelId);
      await message.channel.send(`💥 打錯了！應該是 ${cs.expected}，遊戲結束！`);
      return;
    }

    // 正確
    cs.lastUserId = message.author.id;
    cs.expected++;

    await message.react("✅");

    try {
      await pointsDb.addPoints(message.author.id, 2);
    } catch (err) {
      console.error("❌ Firestore addPoints error:", err);
    }

    return;
  }

  /* ---------------- GUESS ---------------- */

  const gs = guessState.get(channelId);
  if (gs?.active) {
    if (!isIntString(message.content)) return;

    const n = parseInt(message.content);

    if (n === gs.secret) {
      guessState.delete(channelId);
      await message.channel.send(`🎉 猜中了！答案是 ${n}（+10分）`);

      try {
        await pointsDb.addPoints(message.author.id, 10);
      } catch (err) {
        console.error("❌ Firestore addPoints error:", err);
      }

      return;
    }

    if (n < gs.secret) {
      gs.min = n;
    } else {
      gs.max = n;
    }

    await message.channel.send(`🔎 範圍：${gs.min} ~ ${gs.max}`);
    return;
  }
}

/* =========================================================
   HL BUTTON HANDLER
========================================================= */

async function onInteraction(interaction) {
  if (!interaction.isButton()) return;

  const [game, action, ownerId] = interaction.customId.split(":");
  if (game !== "hl") return;

  const channelId = interaction.channelId;
  const st = hlState.get(channelId);
  if (!st) return;

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "❌ 不是你的遊戲", ephemeral: true });
    return;
  }

  if (action === "stop") {
    hlState.delete(channelId);
    await interaction.update({ components: [] });
    await interaction.channel.send(`🛑 遊戲結束，總分：${st.score}`);
    return;
  }

  const next = rand(1, st.max);
  const prev = st.current;

  let correct = false;
  if (action === "hi") correct = next > prev;
  if (action === "lo") correct = next < prev;

  if (!correct) {
    await interaction.update({ components: [] });
    await interaction.channel.send(
      `💥 猜錯！上一張 ${prev}，下一張 ${next}\n本局得分 ${st.score}`
    );
    hlState.delete(channelId);
    return;
  }

  st.score++;
  st.current = next;

  try {
    await pointsDb.addPoints(ownerId, 5);
  } catch (err) {
    console.error("❌ Firestore addPoints error:", err);
  }

  await interaction.update({
    content: `🂠 底牌：${st.current}\n目前得分：${st.score}`,
  });
}

module.exports = {
  games: {
    countingStart,
    countingStop,
    countingStatus,
    guessStart,
    guessStop,
    hlStart,
    hlStop,
  },
  onMessage,
  onInteraction,
};