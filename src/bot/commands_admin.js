"use strict";

/**
 * src/bot/commands_admin.js
 * ✅ /install：建立 遊戲大廳 + 積分區 + 管理員區（含面板）
 * ✅ /ping：測試
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const lobbyButtons = require("./lobbyButtons");

const commandData = [
  new SlashCommandBuilder()
    .setName("install")
    .setDescription("安裝遊戲系統（建立大廳/積分區/管理員區/面板）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("測試機器人是否在線")
    .toJSON(),
];

async function execute(interaction) {
  const name = interaction.commandName;

  if (name === "ping") {
    await interaction.editReply("pong ✅");
    return;
  }

  if (name === "install") {
    // 這裡用 ephemeral 只給管理員看（你 index.js 已經統一 deferReply({ephemeral})）
    await interaction.editReply("🛠️ 安裝中…（建立頻道/分類/面板訊息）");

    // ✅ 一次安裝所有區域（遊戲大廳 + 積分區 + 管理員區）
    // lobbyButtons.js 需要有 module.exports = { installAll, ... }
    await lobbyButtons.installAll(interaction.guild);

    await interaction.editReply(
      "✅ 安裝完成！\n" +
        "🎮 已建立/更新：遊戲大廳（guess/hl/counting）\n" +
        "🪙 已建立/更新：積分區（面板/商城/拍賣）\n" +
        "🛠 已建立/更新：管理員區（管理面板/Counting 控制）"
    );
    return;
  }

  await interaction.editReply("❓ 未知指令。");
}

module.exports = { commandData, execute };