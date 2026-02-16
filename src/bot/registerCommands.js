"use strict";

const { REST, Routes } = require("discord.js");
const { commandData } = require("./commands");

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    console.error("❌ 缺少 ENV：DISCORD_TOKEN / DISCORD_CLIENT_ID");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);

  await rest.put(Routes.applicationCommands(clientId), {
    body: commandData,
  });

  console.log("[Commands] Registered GLOBAL slash commands");
}

module.exports = { registerCommands };