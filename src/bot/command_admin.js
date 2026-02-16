"use strict";

/**
 * 管理/查詢指令：
 * ✅ /install：建立身份組 + 分類 + 大廳 + counting + 規則
 * ✅ /info /points /rank（先保留，points/rank 你之後再接 DB）
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

const { ensureLobbyPosts } = require("./lobbyButtons");

const pointsDb = {
  async getPoints() { return 0; },
  async getLeaderboard() { return []; },
};

function isAdmin(interaction) {
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageGuild);
}

async function safeReply(interaction, payload) {
  // 這裡直接 reply（不要跟按鈕流程混在一起）
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  return interaction.reply(payload);
}

const commandData = [
  new SlashCommandBuilder().setName("install").setDescription("安裝遊戲系統（管理員）"),
  new SlashCommandBuilder().setName("info").setDescription("顯示機器人資訊"),
  new SlashCommandBuilder().setName("points").setDescription("查看自己的積分（僅自己可見）"),
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("查看排行榜（僅自己可見）")
    .addIntegerOption((o) =>
      o.setName("top").setDescription("顯示前幾名（預設 10）").setRequired(false)
    ),
].map((c) => c.toJSON());

// names（要跟你 install 建的一致）
const ROLE_WARN = "⚠️ 賤人";
const ROLE_PERMA = "🚫 永久賤人";
const CAT_NAME = "🎮 遊戲系統";
const CH_LOBBY = "📢-遊戲大廳";
const CH_COUNTING = "🔢-counting";
const CH_RULES = "📜-規則-警告查詢";

async function ensureRole(guild, name) {
  const found = guild.roles.cache.find((r) => r.name === name);
  if (found) return found;
  return guild.roles.create({ name, reason: "bot install" });
}

async function ensureCategory(guild, name) {
  const found = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  if (found) return found;
  return guild.channels.create({ name, type: ChannelType.GuildCategory, reason: "bot install" });
}

async function ensureTextChannel(guild, categoryId, name, overwrites) {
  const found = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name);
  if (found) return found;
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites: overwrites,
    reason: "bot install",
  });
}

async function doInstall(interaction, { client }) {
  if (!isAdmin(interaction)) {
    return safeReply(interaction, {
      content: "❌ 需要管理員權限（Manage Server）才能安裝。",
      flags: MessageFlags.Ephemeral,
    });
  }

  const guild = interaction.guild;
  if (!guild) {
    return safeReply(interaction, { content: "❌ 只能在伺服器內使用。", flags: MessageFlags.Ephemeral });
  }

  // roles
  const roleWarn = await ensureRole(guild, ROLE_WARN);
  const rolePerma = await ensureRole(guild, ROLE_PERMA);

  // category
  const cat = await ensureCategory(guild, CAT_NAME);

  const everyoneId = guild.roles.everyone.id;
  const botId = guild.members.me.id;

  // lobby：只讓 bot 發言
  const lobby = await ensureTextChannel(guild, cat.id, CH_LOBBY, [
    { id: everyoneId, allow: ["ViewChannel", "ReadMessageHistory"], deny: ["SendMessages", "AddReactions"] },
    { id: botId, allow: ["ViewChannel", "SendMessages", "ManageMessages", "ReadMessageHistory"] },
  ]);

  // counting：大家可以發，但 bot 會刪非數字 + 警告
  const counting = await ensureTextChannel(guild, cat.id, CH_COUNTING, [
    { id: everyoneId, allow: ["ViewChannel", "ReadMessageHistory", "SendMessages"], deny: [] },
    { id: botId, allow: ["ViewChannel", "SendMessages", "ManageMessages", "ReadMessageHistory"] },
    // 被警告/永久：不能在 counting 講話（你說 Discord 可限制身份組頻道發言）
    { id: roleWarn.id, allow: ["ViewChannel", "ReadMessageHistory"], deny: ["SendMessages"] },
    { id: rolePerma.id, allow: ["ViewChannel", "ReadMessageHistory"], deny: ["SendMessages"] },
  ]);

  // rules：只讓 bot 發言，放「查詢警告」按鈕
  const rules = await ensureTextChannel(guild, cat.id, CH_RULES, [
    { id: everyoneId, allow: ["ViewChannel", "ReadMessageHistory"], deny: ["SendMessages", "AddReactions"] },
    { id: botId, allow: ["ViewChannel", "SendMessages", "ManageMessages", "ReadMessageHistory"] },
  ]);

  // 讓 bot 補上按鈕訊息（大廳 & 規則）
  await ensureLobbyPosts(client);

  const e = new EmbedBuilder()
    .setTitle("✅ 安裝完成")
    .setDescription(
      [
        `分類：${cat.name}`,
        `頻道：#${lobby.name} / #${counting.name} / #${rules.name}`,
        "",
        "✅ 遊戲啟動方式：到 #📢-遊戲大廳 按按鈕。",
        "✅ Counting：到 #🔢-counting 只能打數字（打文字會被刪 & 記點）。",
      ].join("\n")
    );

  return safeReply(interaction, { embeds: [e], flags: MessageFlags.Ephemeral });
}

async function execute(interaction, { client }) {
  const { commandName } = interaction;

  if (commandName === "install") return doInstall(interaction, { client });

  if (commandName === "info") {
    const e = new EmbedBuilder()
      .setTitle("🎮 遊戲系統")
      .setDescription(
        [
          "大廳按鈕：HL / Guess（不需要打指令）",
          "Counting：在 counting 頻道直接打數字",
          "",
          "指令（管理/查詢）：/install /points /rank /info",
        ].join("\n")
      );
    return safeReply(interaction, { embeds: [e], flags: MessageFlags.Ephemeral });
  }

  if (commandName === "points") {
    const p = await pointsDb.getPoints(interaction.user.id);
    return safeReply(interaction, {
      content: `💰 <@${interaction.user.id}> 目前積分：**${p}**`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (commandName === "rank") {
    const top = interaction.options.getInteger("top") || 10;
    const rows = await pointsDb.getLeaderboard(top);
    if (!rows.length) {
      return safeReply(interaction, { content: "（目前沒有排行榜資料）", flags: MessageFlags.Ephemeral });
    }

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}>：**${r.points}** 分`);
    const e = new EmbedBuilder().setTitle(`🏆 排行榜 Top ${top}`).setDescription(lines.join("\n"));
    return safeReply(interaction, { embeds: [e], flags: MessageFlags.Ephemeral });
  }

  return safeReply(interaction, { content: `❌ 未處理的指令：/${commandName}`, flags: MessageFlags.Ephemeral });
}

module.exports = { commandData, execute };