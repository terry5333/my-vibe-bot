"use strict";

const { SlashCommandBuilder } = require("discord.js");

const commandData = [
  new SlashCommandBuilder()
    .setName("points")
    .setDescription("查詢積分（自己或指定使用者）")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("要查誰").setRequired(false)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("查看積分排行榜（Top 10）")
    .toJSON(),
];

module.exports = { commandData };