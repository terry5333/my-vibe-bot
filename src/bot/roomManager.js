"use strict";

/**
 * 一人只能有一間房：
 * - 如果有 A 房要開 B：跳出「關掉A並建立B / 回去A」
 * - HL/Guess 單人房：不提供邀請按鈕
 * - 房名：<遊戲中文>+<創建人姓名>
 * - 30秒沒行動 -> 倒數 10 秒 -> 關房
 */

const { ChannelType, PermissionFlagsBits } = require("discord.js");

const CAT_NAME = "🎮 遊戲系統";
const ROLE_WARN = "⚠️ 賤人";
const ROLE_PERMA = "🚫 永久賤人";

const activeRooms = new Map(); // userId -> { channelId, gameKey, lastActiveAt, timers... }

function now() {
  return Date.now();
}

function getCategory(guild) {
  return guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CAT_NAME);
}

function userHasBlockRole(member) {
  if (!member) return false;
  const isAdmin =
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild);
  if (isAdmin) return false; // 管理員不受影響

  return member.roles.cache.some((r) => r.name === ROLE_WARN || r.name === ROLE_PERMA);
}

function getRoomOfUser(userId) {
  return activeRooms.get(userId) || null;
}

async function closeRoom(guild, userId, reason = "結束") {
  const info = activeRooms.get(userId);
  if (!info) return;

  activeRooms.delete(userId);

  const ch = guild.channels.cache.get(info.channelId);
  if (!ch) return;

  try {
    await ch.send(`🛑 房間即將關閉（原因：${reason}）`);
  } catch (_) {}

  // 稍等一下讓訊息送出
  setTimeout(async () => {
    try {
      await ch.delete(`close room: ${reason}`);
    } catch (_) {}
  }, 1500);
}

function bumpActivity(userId) {
  const info = activeRooms.get(userId);
  if (!info) return;
  info.lastActiveAt = now();
}

function scheduleAfkTimer(guild, userId) {
  const info = activeRooms.get(userId);
  if (!info) return;

  // 清掉舊的
  if (info.afkTimer) clearTimeout(info.afkTimer);
  if (info.countdownTimer) clearInterval(info.countdownTimer);

  info.afkTimer = setTimeout(async () => {
    const ch = guild.channels.cache.get(info.channelId);
    if (!ch) return closeRoom(guild, userId, "AFK");

    let left = 10;
    try {
      await ch.send("⏳ 30 秒沒有行動，10 秒後自動關閉…");
    } catch (_) {}

    info.countdownTimer = setInterval(async () => {
      left -= 1;
      if (left <= 0) {
        clearInterval(info.countdownTimer);
        await closeRoom(guild, userId, "AFK");
        return;
      }
      try {
        await ch.send(`⏳ 倒數：${left}…`);
      } catch (_) {}
    }, 1000);
  }, 30_000);
}

async function createRoom(interaction, { gameKey, gameNameZh }) {
  const guild = interaction.guild;
  const member = interaction.member;

  if (!guild || !member) {
    await interaction.reply({ content: "❌ 只能在伺服器內使用。", ephemeral: true });
    return null;
  }

  if (userHasBlockRole(member)) {
    await interaction.reply({ content: "🚫 你目前被限制，不能開啟遊戲房間。", ephemeral: true });
    return null;
  }

  const cat = getCategory(guild);
  if (!cat) {
    await interaction.reply({ content: "❌ 找不到「🎮 遊戲系統」分類，請先 /install。", ephemeral: true });
    return null;
  }

  const userId = interaction.user.id;
  const existing = getRoomOfUser(userId);
  if (existing) {
    // 交給 lobbyButtons 顯示選擇 UI
    return { needDecision: true, existing };
  }

  const roomName = `${gameNameZh}+${interaction.user.username}`.slice(0, 90);

  const ch = await guild.channels.create({
    name: roomName,
    type: ChannelType.GuildText,
    parent: cat.id,
    reason: `game room: ${gameKey}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
      { id: guild.members.me.id, allow: ["ViewChannel", "SendMessages", "ManageMessages", "ReadMessageHistory"] },
      { id: userId, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
    ],
  });

  activeRooms.set(userId, {
    channelId: ch.id,
    gameKey,
    lastActiveAt: now(),
    afkTimer: null,
    countdownTimer: null,
  });

  scheduleAfkTimer(guild, userId);

  return { channel: ch, userId };
}

module.exports = {
  getRoomOfUser,
  createRoom,
  closeRoom,
  bumpActivity,
  scheduleAfkTimer,
  userHasBlockRole,
};