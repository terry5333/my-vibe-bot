"use strict";

/**
 * src/bot/games.js
 *
 * ✅ 你的需求：
 * 1) guess 不用 try：管理員直接 /guess set <number> 改答案
 * 2) counting 對/錯都要表情符號
 * 3) counting 同人連打 或 有人打錯 → 直接結束
 * 4) hl 改按鈕式
 * 5) 全部遊戲加分：counting +2 / hl +5 / 終極密碼 +10
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require("discord.js");

const pointsDb = require("../db/points.js");

// ===== 加分規則（你要改就改這裡）=====
const SCORE = {
  COUNTING_OK: 2,
  HL_OK: 5,
  GUESS_OK: 10,
};

// ===== 記憶體狀態（簡單版：重啟會清空）=====
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

// ✅ counting 的 message handler：在頻道直接打數字
async function countingOnMessage(message) {
  const channelId = message.channelId;
  const s = state.counting.get(channelId);
  if (!s || !s.active) return;

  // 只接受「純數字」
  const text = (message.content || "").trim();
  if (!/^\d+$/.test(text)) return;

  const num = Number(text);

  // 連續同一人打 → 直接結束
  if (s.lastUserId && s.lastUserId === message.author.id) {
    await safeReact(message, "⛔");
    await message.channel.send(`🛑 **counting 結束**：<@${message.author.id}> 連續打了兩次！`);
    countingStop(channelId);
    return;
  }

  // 打錯 → 直接結束
  if (num !== s.expected) {
    await safeReact(message, "❌");
    await message.channel.send(`🛑 **counting 結束**：打錯了！應該是 **${s.expected}**`);
    countingStop(channelId);
    return;
  }

  // 打對：✅ +2 分
  await safeReact(message, "✅");
  s.lastUserId = message.author.id;
  s.expected += 1;

  // 加分
  await safeAddPoints(message.author.id, SCORE.COUNTING_OK);

  // 可選：你想要每次提示下一個也行（會吵就關掉）
  // await message.channel.send(`下一個：**${s.expected}**`);
}

// -------------------- HL（按鈕式）--------------------
async function hlStart(interaction, channelId, max = 100) {
  max = Number(max) || 100;
  if (max < 2) max = 2;

  // 如果已經有一局
  const cur = state.hl.get(channelId);
  if (cur?.active) {
    return "❗ 本頻道已經有一局 hl 進行中，請先 `/hl stop`。";
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

  // 你可以改成「顯示目前線索」，我先做最直覺：
  // 讓大家按：偏小/偏大/剛好（剛好才算中）
  const sent = await interaction.channel.send({
    content: `🎲 **HL 開始！**（1 ~ ${max}）\n按按鈕猜：偏小 / 偏大 / 剛好`,
    components: [row],
  });

  const st = state.hl.get(channelId);
  if (st) st.msgId = sent.id;

  const collector = sent.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 60 * 1000, // 60 秒
  });

  collector.on("collect", async (btn) => {
    const st2 = state.hl.get(channelId);
    if (!st2?.active) {
      try { await btn.reply({ content: "這局已結束。", ephemeral: true }); } catch {}
      return;
    }

    // 結束按鈕
    if (btn.customId === "hl_stop") {
      st2.active = false;
      state.hl.delete(channelId);
      collector.stop("stopped");
      try { await btn.reply({ content: "🛑 hl 已結束。", ephemeral: true }); } catch {}
      try { await sent.edit({ components: [] }); } catch {}
      return;
    }

    // 判定：只有「剛好」且剛好猜中才算中
    // 這版 HL 我做成「猜剛好」= 中獎；偏小/偏大會回提示（不加分）
    if (btn.customId === "hl_equal") {
      // ✅ 讓它真的「剛好」才算中：需要玩家同時輸入數字？你沒要輸入數字
      // 所以這裡改成：按「剛好」就是賭一把，若 secret 落在中間？會很怪
      // ✅ 更合理做法：HL 改成「系統出一個 current，玩家猜下一個會高或低」
      // 但你只說要按鈕式，我先做一個「下一張牌高低」版（更標準）
      // ---- 下面直接切成高低牌玩法 ----
    }

    // === 高低牌玩法（標準 HL 按鈕）===
    // 我們把 secret 當作「下一張」，再生成一張 current
    const current = 1 + Math.floor(Math.random() * st2.max);
    const next = st2.secret; // 下一張固定 secret

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

    // 猜錯：只回覆提示，不結束（你沒有說 hl 猜錯要結束，所以保留繼續）
    try {
      await btn.reply({
        content: `❌ 猜錯～\n目前：**${current}** → 下一張：**${next}**\n（再開一局請 `/hl start`）`,
        ephemeral: true,
      });
    } catch {}

    // 這局我做成「猜一次就結束」，避免一直刷按鈕
    st2.active = false;
    state.hl.delete(channelId);
    collector.stop("end");
    try { await sent.edit({ components: [] }); } catch {}
  });

  collector.on("end", async () => {
    // 如果時間到還沒結束，清掉按鈕
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
  // 如果之前已 set 過答案就沿用，不然隨機
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

  // 超出範圍就忽略（或你要提示也可以）
  if (num < s.min || num > s.max) return;

  // 猜到：+10 分，結束
  if (num === s.secret) {
    await safeReact(message, "🎉");
    await safeAddPoints(message.author.id, SCORE.GUESS_OK);
    await message.channel.send(
      `🎊 <@${message.author.id}> **猜到了終極密碼：${s.secret}**！\n✅ +${SCORE.GUESS_OK} 分`
    );
    guessStop(channelId);
    return;
  }

  // 沒猜到：縮範圍提示（終極密碼標準玩法）
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
    return;
  }
}

// -------------------- 安全工具 --------------------
async function safeReact(message, emoji) {
  try {
    await message.react(emoji);
  } catch {}
}

async function safeAddPoints(userId, delta) {
  try {
    if (!pointsDb?.addPoints) return;
    await pointsDb.addPoints(userId, delta);
  } catch (e) {
    console.error("[Points] addPoints error:", e);
  }
}

// -------------------- 對外提供給 events.js 用 --------------------
async function onMessage(message, { client, webRuntime } = {}) {
  // counting / guess 都是「頻道直接輸入數字」模式
  await countingOnMessage(message);
  await guessOnMessage(message);
  // hl 是按鈕，不用 message
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