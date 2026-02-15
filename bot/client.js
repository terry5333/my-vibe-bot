"use strict";

const {
  Client,
  GatewayIntentBits,
  Partials,
} = require("discord.js");

const { registerCommandsIfNeeded } = require("./commands");
const { bindEvents } = require("./events");
const { startPointsListeners } = require("../db/points");
const { startHistoryCleanup } = require("../db/logs");

let client = null;

function getClient() {
  if (!client) throw new Error("Discord client 未初始化");
  return client;
}

async function startBot() {
  if (!process.env.DISCORD_TOKEN) throw new Error("缺少 DISCORD_TOKEN");

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // ✅ 必須：文字遊戲
      GatewayIntentBits.GuildMembers,   // ✅ 需要拿人名/頭像/發 VIP
    ],
    partials: [Partials.Channel],
  });

  bindEvents(client);

  await client.login(process.env.DISCORD_TOKEN);
  console.log("[Discord] Logged in");

  startPointsListeners();
  startHistoryCleanup();

  client.once("ready", async () => {
    console.log("[Discord] Ready as", client.user.tag);
    await registerCommandsIfNeeded();
  });

  return client;
}

module.exports = { startBot, getClient };
