"use strict";

/**
 * src/bot/commands_admin.js
 * ✅ /install：建立大廳、貼按鈕
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const lobbyButtons = require("./lobbyButtons");

const commandData = [
  new SlashCommandBuilder()
    .setName("install")
    .setDescription("安裝遊戲系統（建立大廳與按鈕）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("測試機器人是否在線")
    .toJSON(),
];

async function execute(interaction, ctx) {
  const name = interaction.commandName;

  if (name === "ping") {
    await interaction.editReply("pong ✅");
    return;
  }

  if (name === "install") {
    // 這裡用 ephemeral 只給管理員看（不刷頻）
    await interaction.editReply("🛠️ 安裝中…");

    await lobbyButtons.ensureLobbyChannelsAndButtons(interaction.guild);

    await interaction.editReply("✅ 安裝完成：已建立/更新遊戲大廳與按鈕。");
    return;
  }

  await interaction.editReply("❓ 未知指令。");
}

module.exports = { commandData, execute };