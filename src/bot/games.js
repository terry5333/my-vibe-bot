"use strict";

/**
 * src/bot/games.js
 * - counting：Firestore 狀態（playing/paused/stopped），只在 🟩-counting 且 channelId match 時處理
 *   - 未開始/暫停/停止：刪訊息 + 私訊提醒（DM），並做警告累積
 *   - playing：只允許整數，錯誤/連打兩次 -> 結束並寫回 Firestore
 * - guess：訊息輸入猜數字
 * - hl：按鈕式 high/low
 * - warning system：同頻道規則違反 -> 警告累積（可選 timeout）
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");

const pointsDb = require("../db/points.js");
const countingDb = require("../db/countingState");

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

// ---------- Warning System ----------
/**
 * warnings: key = `${guildId}:${userId}`
 * value = { count, resetAt }
 */
const warnings = new Map();
const WARN_WINDOW_MS = 10 * 60 * 1000; // 10 分鐘內累積
const WARN_MAX = 3; // 3 次後可 timeout（若有權限）
const TIMEOUT_MS = 60 * 1000; // 1 分鐘（可調）

function addWarning(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const cur = warnings.get(key);

  if (!cur || cur.resetAt <= now) {
    warnings.set(key, { count: 1, resetAt: now + WARN_WINDOW_MS });
    return 1;
  }

  cur.count += 1;
  warnings.set(key, cur);
  return cur.count;
}

async function maybeTimeout(member, reason) {
  // 需要 ModerateMembers 權限，且 discord.js v14 member.timeout 可用
  try {
    if (!member?.moderatable) return false;
    await member.timeout(TIMEOUT_MS, reason || "Rule violations").catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function safeDM(user, content) {
  try {
    await user.send(content);
    return true;
  } catch {
    return false;
  }
}

// ---------- COUNTING ----------
/**
 * 用「頻道名稱」先初步辨識 counting 大廳
 * 真正生效再用 Firestore 的 channelId 比對避免誤刪
 */
function isCountingLobbyChannel(message) {
  return message?.channel?.name === "🟩-counting";
}

// 短暫訊息（可選用於頻道公告；這裡主要改用 DM）
async function sendTemp(channel, content, ms = 3000) {
  const m = await channel.send(content).catch(() => null);
  if (!m) return;
  setTimeout(() => m.delete().catch(() => {}), ms);
}

// Firestore countingState 快取（減少每則訊息都打 DB）
const countingCache = new Map(); // guildId -> { data, expiresAt }
const COUNTING_CACHE_MS = 1500; // 1.5 秒快取

async function getCountingStateFresh(guildId) {
  const now = Date.now();
  const cached = countingCache.get(guildId);
  if (cached && cached.expiresAt > now) return cached.data;

  const data = await countingDb.getCounting(guildId);
  countingCache.set(guildId, { data, expiresAt: now + COUNTING_CACHE_MS });
  return data;
}

function invalidateCountingCache(guildId) {
  countingCache.delete(guildId);
}

async function stopCounting(guildId, channelId, reasonText) {
  await countingDb.setCounting(guildId, channelId, {
    state: "stopped",
    expected: 1,
    lastUserId: null,
  });
  invalidateCountingCache(guildId);
  if (reasonText) {
    await sendTemp(
      { send: (...args) => globalThis.__dummySend?.(...args) }, // no-op fallback
      ""
    ).catch(() => {});
  }
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

  await interaction.channel.send({
    content: `🂠 **HL 開始！**（1~${max}）\n✅ **底牌：${current}**\n請按按鈕猜下一張更大/更小。（只有 <@${ownerId}> 能操作）`,
    components: [row],
  });

  hlState.set(channelId, { active: true, max, ownerId, current, score: 0 });
}

// ---------- message handler ----------
async function onMessage(message) {
  if (!message || message.author?.bot) return;
  if (!markMessageHandled(message.id)) return;

  const guildId = message.guildId;
  const channelId = message.channel.id;

  // ===== COUNTING lobby（只在 🟩-counting 且 Firestore 設定的 channelId match 才處理）=====
  if (guildId && isCountingLobbyChannel(message)) {
    // 讀 Firestore 狀態（含 channelId）
    const st = await getCountingStateFresh(guildId).catch(() => null);

    // 如果 Firestore 沒設定 channelId 或不是這個 channel，就不要亂刪（避免誤刪）
    if (!st?.channelId || String(st.channelId) !== String(channelId)) {
      return;
    }

    // 未開始/暫停/停止：全部刪 + 私訊提醒 + 警告
    if (st.state !== "playing") {
      await message.delete().catch(() => {});

      const w = addWarning(guildId, message.author.id);

      // DM 提醒（你要求：還沒開始的提醒改私訊）
      await safeDM(
        message.author,
        `⛔ 目前 Counting 為「${st.state === "paused" ? "暫停" : "未開始/停止"}」。\n` +
          `請等待管理員在「🛠-admin-panel」按下「開始」。\n` +
          `⚠️ 警告：${w}/${WARN_MAX}`
      );

      // 3 次後（可選）timeout
      if (w >= WARN_MAX) {
        const member = message.member;
        await maybeTimeout(member, "Counting rules violations");
      }
      return;
    }

    // playing：只允許整數
    if (!isIntString(message.content)) {
      await message.delete().catch(() => {});
      const w = addWarning(guildId, message.author.id);
      await safeDM(
        message.author,
        `⚠️ Counting 進行中只能輸入「數字」。\n⚠️ 警告：${w}/${WARN_MAX}`
      );
      if (w >= WARN_MAX) {
        await maybeTimeout(message.member, "Counting rules violations");
      }
      return;
    }

    const n = parseInt(message.content.trim(), 10);

    // 同一人連打兩次（以 Firestore lastUserId 判斷）
    if (st.lastUserId && st.lastUserId === message.author.id) {
      await countingDb.setCounting(guildId, channelId, {
        state: "stopped",
        expected: 1,
        lastUserId: null,
      });
      invalidateCountingCache(guildId);

      await message.channel
        .send(`💥 <@${message.author.id}> 連打兩次！Counting 結束。`)
        .catch(() => {});
      return;
    }

    // 打錯
    if (n !== st.expected) {
      await countingDb.setCounting(guildId, channelId, {
        state: "stopped",
        expected: 1,
        lastUserId: null,
      });
      invalidateCountingCache(guildId);

      await message.channel
        .send(
          `💥 <@${message.author.id}> 打錯了！應該是 **${st.expected}**，Counting 結束。`
        )
        .catch(() => {});
      return;
    }

    // 正確 ✅：更新 Firestore expected / lastUserId
    await countingDb
      .setCounting(guildId, channelId, {
        state: "playing",
        expected: st.expected + 1,
        lastUserId: message.author.id,
      })
      .catch(() => {});
    invalidateCountingCache(guildId);

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
    await interaction
      .reply({ content: "❌ 這不是你的 HL。", flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  const channelId = interaction.channelId;
  const st = hlState.get(channelId);
  if (!st?.active) {
    await interaction
      .reply({ content: "ℹ️ 這局 HL 已結束。", flags: MessageFlags.Ephemeral })
      .catch(() => {});
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
    await interaction.channel.send(
      `💥 猜錯！上一張 **${prev}**，下一張 **${next}**。\n🛑 HL 結束。得分：**${st.score}**`
    );
    return;
  }

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

  await interaction
    .update({
      content: `🂠 HL 進行中（1~${st.max}）\n✅ 目前底牌：**${st.current}**\n⭐ 分數：**${st.score}**`,
      components: [row],
    })
    .catch(() => {});
}

// exports
const games = {
  // counting（保留 API 給 lobbyButtons 呼叫，但狀態以 Firestore 為主）
  // 這些函式如果你還會呼叫，會用 Firestore 同步
  async countingStart(guildId, channelId, start = 1) {
    await countingDb.setCounting(guildId, channelId, {
      state: "playing",
      expected: start,
      lastUserId: null,
    });
    invalidateCountingCache(guildId);
  },
  async countingPause(guildId, channelId) {
    await countingDb.setCounting(guildId, channelId, { state: "paused" });
    invalidateCountingCache(guildId);
  },
  async countingStop(guildId, channelId) {
    await countingDb.setCounting(guildId, channelId, {
      state: "stopped",
      expected: 1,
      lastUserId: null,
    });
    invalidateCountingCache(guildId);
  },

  guessSet,
  guessStart,
  guessStop,
  guessStatus,

  hlStart,
  hlStop,
  hlStatus,
};

module.exports = { games, onMessage, onInteraction };