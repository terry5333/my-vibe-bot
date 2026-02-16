"use strict";

/**
 * src/bot/commands_admin.js
 * ✅ 只放管理/查詢型指令：/install /info /points /rank
 * ✅ 回覆一律 editReply（因為 index.js 已 deferReply）
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

// 先給空實作，避免你現在 points/rank 又炸
// 你如果有 pointsDb 就把下面這段改成 require 你的 db
const pointsDb = {
  async getPoints() { return 0; },
  async getLeaderboard() { return []; },
};

function isAdmin(interaction) {
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return (
    perms.has(PermissionFlagsBits.Administrator) ||
    perms.has(PermissionFlagsBits.ManageGuild)
  );
}

async function safeEdit(interaction, payload) {
  // index 已 defer，所以這裡只 editReply
  if (typeof payload === "string") return interaction.editReply({ content: payload });
  return interaction.editReply(payload);
}

/* -------------------- 指令宣告（用來註冊）-------------------- */
const commandData = [
  new SlashCommandBuilder()
    .setName("install")
    .setDescription("安裝：建立身份組/頻道/分類（管理員）"),

  new SlashCommandBuilder()
    .setName("info")
    .setDescription("顯示機器人資訊"),

  new SlashCommandBuilder()
    .setName("points")
    .setDescription("查看自己的積分（私訊/僅自己可見）"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("查看排行榜（僅自己可見）")
    .addIntegerOption((o) =>
      o.setName("top").setDescription("顯示前幾名（預設 10）").setRequired(false)
    ),
].map((c) => c.toJSON());

/* -------------------- /install 需要用到的名稱 -------------------- */
const ROLE_PLAYER = "🎮 玩家";
const ROLE_WARN = "⚠️ 賤人";
const ROLE_PERMA = "🚫 永久賤人";

const CAT_NAME = "🎮 遊戲系統";
const CH_LOBBY = "📢-遊戲大廳";
const CH_COUNTING = "🔢-counting";
const CH_RULES = "📜-規則-警告查詢";

// 建/找 Role
async function ensureRole(guild, name, opts = {}) {
  const found = guild.roles.cache.find((r) => r.name === name);
  if (found) return found;
  return guild.roles.create({
    name,
    reason: "bot install",
    ...opts,
  });
}

// 建/找 Category
async function ensureCategory(guild, name) {
  const found = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name
  );
  if (found) return found;
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: "bot install",
  });
}

// 建/找 Text channel
async function ensureTextChannel(guild, categoryId, name, overwrites) {
  const found = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name
  );
  if (found) return found;

  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites: overwrites,
    reason: "bot install",
  });
}

async function doInstall(interaction) {
  if (!isAdmin(interaction)) {
    return safeEdit(interaction, { content: "❌ 需要管理員權限（Manage Server）才能安裝。", flags: MessageFlags.Ephemeral });
  }

  const guild = interaction.guild;
  if (!guild) {
    return safeEdit(interaction, { content: "❌ 只能在伺服器內使用。", flags: MessageFlags.Ephemeral });
  }

  // 1) Roles
  const rolePlayer = await ensureRole(guild, ROLE_PLAYER, { mentionable: false });
  const roleWarn = await ensureRole(guild, ROLE_WARN, { mentionable: false });
  const rolePerma = await ensureRole(guild, ROLE_PERMA, { mentionable: false });

  // 2) Category
  const cat = await ensureCategory(guild, CAT_NAME);

  // 3) Channels + permissions
  // 你說：遊戲大廳只給機器人發言，其他人鍵盤鎖住
  // counting 頻道：後面會做「非數字刪除 + 警告」
  const everyoneId = guild.roles.everyone.id;

  const baseOverwrites = [
    // everyone: 可看，但不能發
    { id: everyoneId, allow: ["ViewChannel", "ReadMessageHistory"], deny: ["SendMessages", "AddReactions"] },
    // bot: 全權（interaction.user 是管理員不代表 bot）
    { id: guild.members.me.id, allow: ["ViewChannel", "SendMessages", "ManageMessages", "ReadMessageHistory"] },
    // 管理員：可看可發（你要不要讓管理員在大廳說話？你之前說大廳只留 bot，所以這裡也先 deny）
  ];

  const lobby = await ensureTextChannel(guild, cat.id, CH_LOBBY, baseOverwrites);
  const counting = await ensureTextChannel(guild, cat.id, CH_COUNTING, [
    { id: everyoneId, allow: ["ViewChannel", "ReadMessageHistory"], deny: ["SendMessages"] }, // 先鎖，下一包會改成只允許數字
    { id: guild.members.me.id, allow: ["ViewChannel", "SendMessages", "ManageMessages", "ReadMessageHistory"] },
  ]);
  const rules = await ensureTextChannel(guild, cat.id, CH_RULES, baseOverwrites);

  const e = new EmbedBuilder()
    .setTitle("✅ 安裝完成")
    .setDescription(
      [
        `身份組：${rolePlayer} / ${roleWarn} / ${rolePerma}`,
        `分類：${cat.name}`,
        `頻道：#${lobby.name} / #${counting.name} / #${rules.name}`,
        "",
        "下一步：我會在下一包把「遊戲大廳按鈕」「開房系統」「counting 只允許數字+警告」全部接上。",
      ].join("\n")
    );

  return safeEdit(interaction, { embeds: [e], flags: MessageFlags.Ephemeral });
}

/* -------------------- 指令執行 -------------------- */
async function execute(interaction) {
  const { commandName } = interaction;

  if (commandName === "install") return doInstall(interaction);

  if (commandName === "info") {
    const e = new EmbedBuilder()
      .setTitle("🤖 Bot Info")
      .setDescription(
        [
          "目前這版只保留管理/查詢指令，遊戲會改成按鈕開房。",
          "",
          "可用指令：",
          "• /install（管理員）",
          "• /points",
          "• /rank",
        ].join("\n")
      );
    return safeEdit(interaction, { embeds: [e], flags: MessageFlags.Ephemeral });
  }

  if (commandName === "points") {
    const p = await pointsDb.getPoints(interaction.user.id);
    return safeEdit(interaction, {
      content: `💰 <@${interaction.user.id}> 目前積分：**${p}**`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (commandName === "rank") {
    const top = interaction.options.getInteger("top") || 10;
    const rows = await pointsDb.getLeaderboard(top);

    if (!rows.length) {
      return safeEdit(interaction, { content: "（目前沒有排行榜資料）", flags: MessageFlags.Ephemeral });
    }

    const lines = rows.map((r, i) => `**${i + 1}.** <@${r.userId}>：**${r.points}** 分`);
    const e = new EmbedBuilder().setTitle(`🏆 排行榜 Top ${top}`).setDescription(lines.join("\n"));
    return safeEdit(interaction, { embeds: [e], flags: MessageFlags.Ephemeral });
  }

  return safeEdit(interaction, { content: `❌ 未處理的指令：/${commandName}`, flags: MessageFlags.Ephemeral });
}

module.exports = {
  commandData,
  execute,
};