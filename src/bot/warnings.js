"use strict";

/**
 * counting 規則：
 * ✅ 只能數字
 * ✅ 非數字 -> 刪除 + DM 提醒 + 記點
 * ✅ 同一人累積 2 次文字 -> 給 ⚠️ 賤人 3 天
 * ✅ 警告解除後再犯 -> 🚫 永久賤人
 * ✅ 管理員不受影響
 * ✅ 規則頻道按鈕可查詢：警告/永久 + 到期時間
 *
 * 記錄存在本地檔案：/app/data/punishments.json（容器可用）
 */

const fs = require("fs");
const path = require("path");
const { PermissionFlagsBits } = require("discord.js");

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "punishments.json");

const ROLE_WARN = "⚠️ 賤人";
const ROLE_PERMA = "🚫 永久賤人";
const COUNTING_CHANNEL_NAME = "🔢-counting";

const STRIKE_WINDOW_MS = 60 * 60 * 1000; // 1 小時內兩次文字 -> 警告
const WARN_DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 天

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {} }, null, 2), "utf8");
}

function loadDb() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { users: {} };
  }
}

function saveDb(db) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

function isAdminMember(member) {
  if (!member) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function isNumericMessage(content) {
  const s = String(content || "").trim();
  if (!s) return false;
  return /^[0-9]+$/.test(s);
}

async function dmUser(user, text) {
  try {
    await user.send(text);
  } catch (_) {}
}

async function getRoles(guild) {
  const warn = guild.roles.cache.find((r) => r.name === ROLE_WARN);
  const perma = guild.roles.cache.find((r) => r.name === ROLE_PERMA);
  return { warn, perma };
}

async function tryCleanupExpiredPunishments(guild) {
  const db = loadDb();
  const now = Date.now();
  const { warn, perma } = await getRoles(guild);
  if (!warn || !perma) return;

  for (const [userId, u] of Object.entries(db.users || {})) {
    if (u.warnUntil && now > u.warnUntil) {
      // 到期：移除 warn role
      try {
        const m = await guild.members.fetch(userId).catch(() => null);
        if (m && m.roles.cache.has(warn.id)) {
          await m.roles.remove(warn, "warn expired");
        }
      } catch (_) {}
      u.warnUntil = null;
      saveDb(db);
    }
  }
}

async function punishWarn(guild, member) {
  const db = loadDb();
  const { warn, perma } = await getRoles(guild);
  if (!warn || !perma) return;

  const u = (db.users[member.id] ||= {});
  const now = Date.now();

  // 若曾經警告過且已解除，這次再犯 -> 永久
  if (u.hadWarn === true && (!u.warnUntil || now > u.warnUntil)) {
    u.perma = true;
    u.warnUntil = null;
    saveDb(db);

    try {
      await member.roles.remove(warn).catch(() => {});
      await member.roles.add(perma, "repeat offense -> perma");
    } catch (_) {}

    await dmUser(member.user, `🚫 你再次在 counting 違規，已被標記為「永久賤人」，無法參與遊戲房間。`);
    return;
  }

  // 否則給 3 天警告
  u.hadWarn = true;
  u.warnUntil = now + WARN_DURATION_MS;
  u.perma = false;
  saveDb(db);

  try {
    await member.roles.remove(perma).catch(() => {});
    await member.roles.add(warn, "counting text twice -> warn 3 days");
  } catch (_) {}

  await dmUser(member.user, `⚠️ 你在 counting 打文字累積 2 次，已被標記為「賤人」3 天（期間不能開/進遊戲房間）。`);
}

async function addStrike(guild, member) {
  const db = loadDb();
  const u = (db.users[member.id] ||= {});
  const now = Date.now();

  // 清理過期 strike
  if (!u.strikes) u.strikes = [];
  u.strikes = u.strikes.filter((t) => now - t <= STRIKE_WINDOW_MS);

  u.strikes.push(now);
  saveDb(db);

  if (u.strikes.length >= 2) {
    u.strikes = [];
    saveDb(db);
    await punishWarn(guild, member);
    return { punished: true };
  }

  return { punished: false, remaining: 2 - u.strikes.length };
}

async function handleCountingMessage(message) {
  const guild = message.guild;
  const channel = message.channel;

  if (!guild || !channel) return;
  if (channel.name !== COUNTING_CHANNEL_NAME) return;

  // 管理員不受影響
  const member = message.member;
  if (isAdminMember(member)) return;

  // 若有 warn/perma role：就算他能講，也先直接刪（避免他洗頻）
  // （權限面也已 deny SendMessages，但保險）
  const { warn, perma } = await getRoles(guild);
  const blocked =
    member?.roles?.cache?.some((r) => r.name === ROLE_WARN || r.name === ROLE_PERMA) ?? false;

  // counting 只能數字
  if (!isNumericMessage(message.content) || blocked) {
    try {
      await message.delete();
    } catch (_) {}

    const res = await addStrike(guild, member);
    await dmUser(
      message.author,
      res.punished
        ? "⚠️ 你在 counting 再次打文字，已被處罰。"
        : `⚠️ counting 只能打數字。你已記 1 次（再 ${res.remaining} 次會被處罰）。`
    );
  }
}

async function getPunishInfoForUser(guild, userId) {
  const db = loadDb();
  const u = db.users?.[userId] || {};
  const now = Date.now();

  const warnUntil = u.warnUntil && u.warnUntil > now ? u.warnUntil : null;
  const perma = u.perma === true;

  if (perma) {
    return "🚫 狀態：**永久賤人**\n限制：不能開/進遊戲房間（永久）。";
  }

  if (warnUntil) {
    const d = new Date(warnUntil);
    return `⚠️ 狀態：**賤人（警告中）**\n到期：${d.toLocaleString("zh-TW")}\n限制：到期前不能開/進遊戲房間。`;
  }

  return "✅ 狀態：正常\n目前沒有警告或永久紀錄。";
}

module.exports = {
  handleCountingMessage,
  tryCleanupExpiredPunishments,
  getPunishInfoForUser,
};