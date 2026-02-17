"use strict";

/**
 * src/bot/commands_admin.js
 * ✅ /install：建立大廳、貼按鈕
 * ✅ /close：刪除整個系統（遊戲大廳/房間/積分/管理員區 等分類與頻道）
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
} = require("discord.js");

const lobbyButtons = require("./lobbyButtons");

// 你系統用到的分類名稱（跟 lobbyButtons.js 一致）
const CATEGORY_LOBBIES = "🎮 遊戲大廳";
const CATEGORY_ROOMS = "🎲 遊戲房間";

// 下面兩個如果你已經有做「積分區/管理員區」就填你實際的分類名稱
// （先給常見名字，你可以改成你自己的）
const CATEGORY_POINTS = "💰 積分系統";
const CATEGORY_ADMIN = "🛠️ 管理員區";

// ===== Slash Commands =====
const commandData = [
  new SlashCommandBuilder()
    .setName("install")
    .setDescription("安裝遊戲系統（建立大廳與按鈕）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("close")
    .setDescription("【危險】關閉系統：刪除所有遊戲/積分/管理員相關頻道")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder().setName("ping").setDescription("測試機器人是否在線").toJSON(),
];

// ===== helpers =====
async function deleteCategoryAndChildren(guild, categoryName) {
  const cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === categoryName
  );
  if (!cat) return { deleted: 0, found: false };

  // 刪掉底下所有頻道
  const children = guild.channels.cache.filter((c) => c.parentId === cat.id);
  let deleted = 0;

  for (const [, ch] of children) {
    await ch.delete(`system close: delete child of ${categoryName}`).catch(() => {});
    deleted++;
  }

  // 最後刪分類
  await cat.delete(`system close: delete category ${categoryName}`).catch(() => {});
  deleted++;

  return { deleted, found: true };
}

async function execute(interaction, ctx) {
  const name = interaction.commandName;

  if (name === "ping") {
    await interaction.editReply("pong ✅");
    return;
  }

  if (name === "install") {
    await interaction.editReply("🛠️ 安裝中…");
    await lobbyButtons.ensureLobbyChannelsAndButtons(interaction.guild);
    await interaction.editReply("✅ 安裝完成：已建立/更新遊戲大廳與按鈕。");
    return;
  }

  if (name === "close") {
    // 先跳確認（ephemeral 只有管理員看到）
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("admin:close:confirm")
        .setLabel("⚠️ 確認刪除全部系統頻道")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("admin:close:cancel")
        .setLabel("取消")
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
      content:
        "⚠️ **危險操作**：將刪除「遊戲大廳 / 遊戲房間 / 積分系統 / 管理員區」相關分類與底下所有頻道。\n" +
        "確定要繼續嗎？（此操作不可復原）",
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.editReply("❓ 未知指令。");
}

module.exports = { commandData, execute };

// ====== 下面給 lobbyButtons 用：管理員按鈕處理 ======
module.exports.handleAdminCloseButtons = async function handleAdminCloseButtons(interaction) {
  if (!interaction.isButton()) return false;

  const id = interaction.customId;
  if (id === "admin:close:cancel") {
    await interaction.update({ content: "✅ 已取消。", components: [] }).catch(() => {});
    return true;
  }

  if (id === "admin:close:confirm") {
    await interaction.update({ content: "🧹 正在刪除系統頻道…", components: [] }).catch(() => {});

    const guild = interaction.guild;

    // 依序刪分類（找不到就跳過）
    const results = [];
    results.push(await deleteCategoryAndChildren(guild, CATEGORY_ROOMS));
    results.push(await deleteCategoryAndChildren(guild, CATEGORY_LOBBIES));
    results.push(await deleteCategoryAndChildren(guild, CATEGORY_POINTS));
    results.push(await deleteCategoryAndChildren(guild, CATEGORY_ADMIN));

    const totalDeleted = results.reduce((sum, r) => sum + (r.deleted || 0), 0);

    await interaction.followUp({
      content: `✅ 關閉完成：已刪除 **${totalDeleted}** 個頻道/分類（找不到的分類會自動略過）。`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});

    return true;
  }

  return false;
};