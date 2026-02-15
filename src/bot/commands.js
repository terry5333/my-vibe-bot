"use strict";

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder().setName("points").setDescription("查看我的積分"),
  new SlashCommandBuilder().setName("rank").setDescription("查看排行榜（秒回快取）"),

  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("終極密碼（此頻道猜數字）")
    .addIntegerOption((o) => o.setName("min").setDescription("最小值（預設 1）").setRequired(false))
    .addIntegerOption((o) => o.setName("max").setDescription("最大值（預設 100）").setRequired(false)),

  new SlashCommandBuilder().setName("hl").setDescription("高低牌（按鈕猜更大/更小）"),

  new SlashCommandBuilder()
    .setName("counting")
    .setDescription("數字接龍（每次正確加分）")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("在此頻道啟動接龍")
        .addIntegerOption((o) => o.setName("start").setDescription("起始數字（預設 1）").setRequired(false))
        .addIntegerOption((o) => o.setName("reward").setDescription("每次正確加幾分（預設 1）").setRequired(false))
    )
    .addSubcommand((s) => s.setName("stop").setDescription("停止此頻道接龍"))
    .addSubcommand((s) => s.setName("status").setDescription("查看此頻道接龍狀態")),

  new SlashCommandBuilder()
    .setName("setup-role")
    .setDescription("產生身分組切換按鈕（有則移除，無則加入）")
    .addRoleOption((o) => o.setName("role").setDescription("要切換的身分組").setRequired(true))
    .addStringOption((o) => o.setName("label").setDescription("按鈕文字（可選）").setRequired(false)),

  new SlashCommandBuilder()
    .setName("weekly")
    .setDescription("每週結算（管理員）")
    .addSubcommand((s) => s.setName("preview").setDescription("預覽本週 Top 與獎勵"))
    .addSubcommand((s) => s.setName("payout").setDescription("發放本週獎勵（每週一次）")),
].map((c) => c.toJSON());

async function registerCommandsIfNeeded() {
  const on = String(process.env.REGISTER_COMMANDS || "").toLowerCase() === "true";
  if (!on) return console.log("[Commands] REGISTER_COMMANDS=false，略過註冊");

  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) throw new Error("缺少 DISCORD_TOKEN / DISCORD_CLIENT_ID");

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("[Commands] Registered global slash commands");
}

module.exports = { registerCommandsIfNeeded };
