"use strict";

/**
 * src/bot/games.js
 *
 * 文字觸發遊戲：
 *  - 終極密碼：!up start / !up end / !up reset / !up status / !up <number>
 *  - 數字接龍：!count start / !count end / !count reset / !count status / 直接輸入數字就算
 *
 * 每個「頻道」各自一局（不會互相干擾）
 */

const PREFIX_UP = "!up";
const PREFIX_COUNT = "!count";

// -------------------- In-memory states (per channel) --------------------
/** @type {Map<string, {active:boolean, low:number, high:number, answer:number, tries:number, startedBy:string, startedAt:number}>} */
const upState = new Map();

/** @type {Map<string, {active:boolean, next:number, lastUserId:string|null, startedBy:string, startedAt:number, streak:number}>} */
const countState = new Map();

// -------------------- Helpers --------------------
function now() {
  return Date.now();
}

function chanId(message) {
  return message?.channel?.id || "unknown";
}

function isAdminLike(member) {
  // 管理員/伺服器管理權限
  try {
    return Boolean(member?.permissions?.has?.("Administrator") || member?.permissions?.has?.("ManageGuild"));
  } catch {
    return false;
  }
}

function parseIntSafe(s) {
  const n = Number(String(s).trim());
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  return n;
}

function clampRange(low, high) {
  // 避免太誇張的範圍（防刷/防亂）
  const MIN = -1000000;
  const MAX = 1000000;
  const l = Math.max(MIN, Math.min(MAX, low));
  const h = Math.max(MIN, Math.min(MAX, high));
  return [Math.min(l, h), Math.max(l, h)];
}

function pickAnswer(low, high) {
  // inclusive
  const r = Math.floor(Math.random() * (high - low + 1)) + low;
  return r;
}

function mention(userId) {
  return `<@${userId}>`;
}

async function safeReply(message, content) {
  try {
    return await message.reply({ content, allowedMentions: { repliedUser: false } });
  } catch {
    try {
      return await message.channel.send({ content });
    } catch {
      return null;
    }
  }
}

function helpText() {
  return [
    "🎮 **遊戲指令**",
    "",
    "**終極密碼**（每頻道一局）",
    `- \`${PREFIX_UP} start [min] [max]\`：開始（預設 1~100）`,
    `- \`${PREFIX_UP} <數字>\`：猜答案`,
    `- \`${PREFIX_UP} status\`：看目前範圍與次數`,
    `- \`${PREFIX_UP} reset\`：重置本頻道`,
    `- \`${PREFIX_UP} end\`：結束（管理員/開局者）`,
    "",
    "**數字接龍 Counting**（每頻道一局）",
    `- \`${PREFIX_COUNT} start [起始數]\`：開始（預設從 1 開始）`,
    `- 直接在頻道輸入數字：進行接龍（必須是下一個數）`,
    `- \`${PREFIX_COUNT} status\`：看目前下一個要接的數`,
    `- \`${PREFIX_COUNT} reset\`：重置本頻道`,
    `- \`${PREFIX_COUNT} end\`：結束（管理員/開局者）`,
  ].join("\n");
}

// -------------------- Ultimate Password --------------------
async function upHandle(message, args) {
  const cid = chanId(message);
  const sub = (args[0] || "").toLowerCase();

  // help
  if (sub === "help" || sub === "h" || sub === "?") {
    return safeReply(message, helpText());
  }

  // start
  if (sub === "start") {
    // !up start [min] [max]
    let low = 1;
    let high = 100;

    const a1 = args[1];
    const a2 = args[2];
    const n1 = a1 !== undefined ? parseIntSafe(a1) : null;
    const n2 = a2 !== undefined ? parseIntSafe(a2) : null;

    if (n1 !== null && n2 !== null) {
      low = n1;
      high = n2;
    } else if (n1 !== null && n2 === null) {
      // 只給一個數字就當上限：1~n1
      low = 1;
      high = n1;
    }

    [low, high] = clampRange(low, high);

    if (high - low < 5) {
      return safeReply(message, "⚠️ 範圍太小了，至少要差 5 以上喔（例如 1~100）。");
    }

    const answer = pickAnswer(low, high);
    upState.set(cid, {
      active: true,
      low,
      high,
      answer,
      tries: 0,
      startedBy: message.author.id,
      startedAt: now(),
    });

    return safeReply(
      message,
      `🔐 **終極密碼開始！**\n範圍：**${low} ~ ${high}**\n用 \`${PREFIX_UP} <數字>\` 來猜！`
    );
  }

  // status
  if (sub === "status") {
    const st = upState.get(cid);
    if (!st?.active) return safeReply(message, "ℹ️ 本頻道目前沒有進行中的終極密碼。用 `!up start` 開始。");
    return safeReply(
      message,
      `🔐 **終極密碼狀態**\n範圍：**${st.low} ~ ${st.high}**\n嘗試次數：**${st.tries}**`
    );
  }

  // reset
  if (sub === "reset") {
    upState.delete(cid);
    return safeReply(message, "♻️ 已重置本頻道的終極密碼狀態。");
  }

  // end
  if (sub === "end" || sub === "stop") {
    const st = upState.get(cid);
    if (!st?.active) return safeReply(message, "ℹ️ 本頻道目前沒有進行中的終極密碼。");

    const allowed = st.startedBy === message.author.id || isAdminLike(message.member);
    if (!allowed) return safeReply(message, "⛔ 只有開局者或管理員可以結束這局。");

    upState.delete(cid);
    return safeReply(message, "🧹 已結束本頻道的終極密碼。");
  }

  // guess number: !up 50
  const st = upState.get(cid);
  const guess = parseIntSafe(sub);

  if (guess === null) {
    return safeReply(message, "❓ 指令不懂。輸入 `!up help` 看用法。");
  }

  if (!st?.active) {
    return safeReply(message, "ℹ️ 本頻道還沒開始終極密碼。用 `!up start` 開始。");
  }

  st.tries += 1;

  if (guess <= st.low || guess >= st.high) {
    return safeReply(message, `⚠️ 你猜的 **${guess}** 不在目前有效範圍（必須介於 **${st.low}** 和 **${st.high}** 之間）。`);
  }

  if (guess === st.answer) {
    upState.delete(cid);
    return safeReply(
      message,
      `🎉 ${mention(message.author.id)} **猜中了！答案就是 ${guess}**\n（本局共嘗試 ${st.tries} 次）\n再來一局：\`${PREFIX_UP} start\``
    );
  }

  if (guess < st.answer) st.low = guess;
  else st.high = guess;

  upState.set(cid, st);

  return safeReply(message, `🔎 ${mention(message.author.id)} 目前範圍：**${st.low} ~ ${st.high}**（第 ${st.tries} 次）`);
}

// -------------------- Counting --------------------
async function countHandleCommand(message, args) {
  const cid = chanId(message);
  const sub = (args[0] || "").toLowerCase();

  // help
  if (sub === "help" || sub === "h" || sub === "?") {
    return safeReply(message, helpText());
  }

  // start
  if (sub === "start") {
    // !count start [startNumber]  -> next should be startNumber (default 1)
    const startN = args[1] !== undefined ? parseIntSafe(args[1]) : 1;
    if (startN === null) return safeReply(message, "⚠️ 起始數必須是整數。例：`!count start 1`");

    countState.set(cid, {
      active: true,
      next: startN,
      lastUserId: null,
      startedBy: message.author.id,
      startedAt: now(),
      streak: 0,
    });

    return safeReply(
      message,
      `🔢 **數字接龍開始！**\n下一個要接：**${startN}**\n直接在頻道輸入數字即可（例如：\`${startN}\`）。`
    );
  }

  // status
  if (sub === "status") {
    const st = countState.get(cid);
    if (!st?.active) return safeReply(message, "ℹ️ 本頻道目前沒有進行中的數字接龍。用 `!count start` 開始。");
    return safeReply(message, `🔢 **數字接龍狀態**\n下一個要接：**${st.next}**\n連續成功：**${st.streak}**`);
  }

  // reset
  if (sub === "reset") {
    countState.delete(cid);
    return safeReply(message, "♻️ 已重置本頻道的數字接龍狀態。");
  }

  // end
  if (sub === "end" || sub === "stop") {
    const st = countState.get(cid);
    if (!st?.active) return safeReply(message, "ℹ️ 本頻道目前沒有進行中的數字接龍。");

    const allowed = st.startedBy === message.author.id || isAdminLike(message.member);
    if (!allowed) return safeReply(message, "⛔ 只有開局者或管理員可以結束。");

    countState.delete(cid);
    return safeReply(message, "🧹 已結束本頻道的數字接龍。");
  }

  return safeReply(message, "❓ 指令不懂。輸入 `!count help` 看用法。");
}

async function countHandleNumberMessage(message) {
  const cid = chanId(message);
  const st = countState.get(cid);
  if (!st?.active) return;

  const n = parseIntSafe(message.content);
  if (n === null) return;

  // 防同一人連續
  if (st.lastUserId && st.lastUserId === message.author.id) {
    // 這裡我選擇「提醒但不結束」，避免太兇
    return safeReply(message, `⚠️ ${mention(message.author.id)} 不能連續接兩次，換別人接：**${st.next}**`);
  }

  if (n !== st.next) {
    // 錯了就重置到起始（或你想要直接 end 也可以）
    const expected = st.next;
    const restart = (st.next - st.streak); // 估算起始，保持概念，不依賴外部
    countState.set(cid, {
      active: true,
      next: expected, // 保持下一個不變也可以，但這裡選擇直接重置到 1
      lastUserId: null,
      startedBy: st.startedBy,
      startedAt: st.startedAt,
      streak: 0,
    });

    // 我這裡改成「直接重置到 1」，更常見
    const resetTo = 1;
    countState.set(cid, {
      active: true,
      next: resetTo,
      lastUserId: null,
      startedBy: st.startedBy,
      startedAt: st.startedAt,
      streak: 0,
    });

    return safeReply(
      message,
      `💥 錯了！你輸入 **${n}**，應該要是 **${expected}**。\n已重置，下一個請輸入：**${resetTo}**`
    );
  }

  // correct
  st.lastUserId = message.author.id;
  st.next += 1;
  st.streak += 1;
  countState.set(cid, st);

  // 不狂洗頻道：每 10 次回一次，或你也可以改成每次都回
  if (st.streak % 10 === 0) {
    return safeReply(message, `✅ 目前連續成功：**${st.streak}**，下一個：**${st.next}**`);
  }
}

// -------------------- Entry --------------------
async function onMessage(message, { client, webRuntime } = {}) {
  try {
    if (!message || message.author?.bot) return;
    if (!message.guild) return; // 只處理伺服器內訊息（要支援私訊可移除）

    const content = (message.content || "").trim();
    if (!content) return;

    // help
    if (content === "!game" || content === "!games" || content === "!help") {
      return safeReply(message, helpText());
    }

    // Ultimate Password commands
    if (content.toLowerCase().startsWith(PREFIX_UP)) {
      const args = content.split(/\s+/).slice(1);
      return upHandle(message, args);
    }

    // Counting commands
    if (content.toLowerCase().startsWith(PREFIX_COUNT)) {
      const args = content.split(/\s+/).slice(1);
      return countHandleCommand(message, args);
    }

    // Counting number messages (only if counting active)
    await countHandleNumberMessage(message);
  } catch (err) {
    console.error("❌ [Games] onMessage error:", err);
  }
}

module.exports = { onMessage };