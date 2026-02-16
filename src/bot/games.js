"use strict";

/**
 * src/bot/games.js
 * 修正：模板字串內不能直接再放 `...`
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require("discord.js");

const pointsDb = require("../db/points.js");

const SCORE = {
  COUNTING_OK: 2,
  HL_OK: 5,
  GUESS_OK: 10,
};

const state = {
  counting: new Map(), // channelId -> { active, expected, lastUserId }
  hl: new Map(),       // channelId -> { active, max, secret, msgId }
  guess: new Map(),    // channelId -> { active, min, max, secret }
};

// -------------------- Counting --------------------
function countingStart(channelId, startNumber = 1) {
  state.counting.set(channelId, {
    active: true,
    expected: Number(startNumber) || 1,
    lastUserId: null,
  });
}

function countingStop(channelId) {
  state.counting.delete(channelId);
}

function countingStatus(channelId) {
  return state.counting.get(channelId) || { active: false };
}

async function countingOnMessage(message) {
  const channelId = message.channelId;
  const s = state.counting.get(channelId);
  if (!s || !s.active) return;

  const text = (message.content || "").trim();
  if (!/^\d+$/.test(text)) return;

  const num = Number(text);

  if (s.lastUserId && s.lastUserId === message.author.id) {
    await safeReact(message, "⛔");
    await message.channel.send(`🛑 **counting 結束**：<@${message.author.id}> 連續打了兩次！`);
    countingStop(channelId);
    return;
  }

  if (num !== s.expected) {
    await safeReact(message, "❌");
    await message.channel.send(`🛑 **counting 結束**：打錯了！應該是 **${s.expected}**`);
    countingStop(channelId);
    return;
  }

  await safeReact(message, "✅");
  s.lastUserId = message.author.id;
  s.expected += 1;

  await safeAddPoints(message.author.id, SCORE.COUNTING_OK);
}

// -------------------- HL（按鈕式）--------------------
async function hlStart(interaction, channelId, max = 100) {
  max = Number(max) || 100;
  if (max < 2) max = 2;

  const cur = state.hl.get(channelId);
  if (cur?.active) {
    return "❗ 本頻道已經有一局 hl 進行中，請先 /hl stop。";
  }

  const secret = 1 + Math.floor(Math.random() * max);

  state.hl.set(channelId, {
    active: true,
    max,
    secret,
    msgId: null,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("hl_low").setLabel("猜：偏小").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("hl_high").setLabel("猜：偏大").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("hl_equal").setLabel("猜：剛好").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("hl_stop").setLabel("結束").setStyle(ButtonStyle.Secondary),
  );

  const sent = await interaction.channel.send({
    content: `🎲 **HL 開始！**（1 ~ ${max}）\n按按鈕猜：偏小 / 偏大 / 剛好`,
    components: [row],
  });

  const st = state.hl.get(channelId);
  if (st) st.msgId = sent.id;

  const collector = sent.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60 * 1000,
  });

  collector.on("collect", async (btn) => {
    const st2 = state.hl.get(channelId);
    if (!st2?.active) {
      try { await btn.reply({ content: "這局已結束。", ephemeral: true }); } catch {}
      return;
    }

    if (btn.customId === "hl_stop") {
      st2.active = false;
      state.hl.delete(channelId);
      collector.stop("stopped");
      try { await btn.reply({ content: "🛑 hl 已結束。", ephemeral: true }); } catch {}
      try { await sent.edit({ components: [] }); } catch {}
      return;
    }

    // 標準「高低牌」玩法：先抽 current，再用 secret 當 next
    const current = 1 + Math.floor(Math.random() * st2.max);
    const next = st2.secret;

    let correct = false;
    if (btn.customId === "hl_low") correct = next < current;
    if (btn.customId === "hl_high") correct = next > current;
    if (btn.customId === "hl_equal") correct = next === current;

    if (correct) {
      await safeAddPoints(btn.user.id, SCORE.HL_OK);

      st2.active = false;
      state.hl.delete(channelId);
      collector.stop("win");

      try {
        await btn.reply({
          content: `🎉 <@${btn.user.id}> 猜對了！\n目前：**${current}** → 下一張：**${next}**\n✅ +${SCORE.HL_OK} 分`,
        });
      } catch {}

      try { await sent.edit({ components: [] }); } catch {}
      return;
    }

    // ❌ 這行之前炸掉就是因為你塞了 `...` 反引號
    try {
      await btn.reply({
        content: `❌ 猜錯～\n目前：**${current}** → 下一張：**${next}**\n（再開一局請 /hl start）`,
        ephemeral: true,
      });
    } catch {}

    // 這版設計：猜一次就結束（避免按鈕狂刷）
    st2.active = false;
    state.hl.delete(channelId);
    collector.stop("end");
    try { await sent.edit({ components: [] }); } catch {}
  });

  collector.on("end", async () => {
    try {
      const st3 = state.hl.get(channelId);
      if (st3?.active) state.hl.delete(channelId);
      await sent.edit({ components: [] });
    } catch {}
  });

  return "✅ 已送出 hl 按鈕！";
}

function hlStop(channelId) {
  state.hl.delete(channelId);
}

function hlStatus(channelId) {
  const s = state.hl.get(channelId);
  if (!s) return { active: false };
  return { active: !!s.active, max: s.max };
}

// -------------------- 終極密碼 Guess（頻道直接輸入數字）--------------------
function guessSet(channelId, { min = 1, max = 100, secret }) {
  min = Number(min) || 1;
  max = Number(max) || 100;
  secret = Number(secret);

  if (!Number.isFinite(secret)) throw new Error("secret must be a number");
  if (min > max) [min, max] = [max, min];

  if (secret < min) secret = min;
  if (secret > max) secret = max;

  state.guess.set(channelId, { active: true, min, max, secret });
}

function guessStart(channelId, { min = 1, max = 100 } = {}) {
  min = Number(min) || 1;
  max = Number(max) || 100;
  if (min > max) [min, max] = [max, min];

  const cur = state.guess.get(channelId);
  const secret =
    cur?.secret && cur.secret >= min && cur.secret <= max
      ? cur.secret
      : min + Math.floor(Math.random() * (max - min + 1));

  state.guess.set(channelId, { active: true, min, max, secret });
}

function guessStop(channelId) {
  state.guess.delete(channelId);
}

function guessStatus(channelId) {
  return state.guess.get(channelId) || { active: false };
}

async function guessOnMessage(message) {
  const channelId = message.channelId;
  const s = state.guess.get(channelId);
  if (!s?.active) return;

  const text = (message.content || "").trim();
  if (!/^\d+$/.test(text)) return;

  const num = Number(text);
  if (num < s.min || num > s.max) return;

  if (num === s.secret) {
    await safeReact(message, "🎉");
    await safeAddPoints(message.author.id, SCORE.GUESS_OK);
    await message.channel.send(
      `🎊 <@${message.author.id}> **猜到了終極密碼：${s.secret}**！\n✅ +${SCORE.GUESS_OK} 分`
    );
    guessStop(channelId);
    return;
  }

  if (num < s.secret) {
    s.min = Math.max(s.min, num + 1);
    await safeReact(message, "⬆️");
    await message.channel.send(`⬆️ 太小了！新範圍：**${s.min} ~ ${s.max}**`);
    return;
  }

  if (num > s.secret) {
    s.max = Math.min(s.max, num - 1);
    await safeReact(message, "⬇️");
    await message.channel.send(`⬇️ 太大了！新範圍：**${s.min} ~ ${s.max}**`);
  }
}

// -------------------- 工具 --------------------
async function safeReact(message, emoji) {
  try { await message.react(emoji); } catch {}
}

async function safeAddPoints(userId, delta) {
  try {
    if (!pointsDb?.addPoints) return;
    await pointsDb.addPoints(userId, delta);
  } catch (e) {
    console.error("[Points] addPoints error:", e);
  }
}

// 給 events.js 用
async function onMessage(message) {
  await countingOnMessage(message);
  await guessOnMessage(message);
}

const games = {
  countingStart,
  countingStop,
  countingStatus,

  hlStart,
  hlStop,
  hlStatus,

  guessSet,
  guessStart,
  guessStop,
  guessStatus,
};

module.exports = { games, onMessage };