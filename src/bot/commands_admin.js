"use strict";

/**
 * /install：建立系統（分類/頻道/面板/身份組）
 * /close：刪除系統（分類/頻道/身份組/狀態）
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const system = require("./system");

const commandData = [
  new SlashCommandBuilder()
    .setName("install")
    .setDescription("安裝遊戲系統（建立大廳/面板/身份組）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("close")
    .setDescription("關閉系統（刪除大廳/積分/管理員頻道與身份組）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder().setName("ping").setDescription("測試機器人是否在線").toJSON(),
];

async function execute(interaction) {
  const name = interaction.commandName;

  if (name === "ping") {
    await interaction.editReply("pong ✅");
    return;
  }

  if (name === "install") {
    await interaction.editReply("🛠️ 安裝中…");
    await system.install(interaction.guild);
    await interaction.editReply("✅ 安裝完成（大廳/積分/管理員面板已建立/更新）。");
    return;
  }

  if (name === "close") {
    await interaction.editReply("🧹 關閉系統中…");
    await system.close(interaction.guild);
    await interaction.editReply("✅ 系統已關閉（已刪除建立的分類/頻道/身份組）。");
    return;
  }

  await interaction.editReply("❓ 未知指令。");
}

module.exports = { commandData, execute };