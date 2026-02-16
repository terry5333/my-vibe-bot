"use strict";

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { initFirebase } = require("./db/firebase");
const { registerCommands, makeCommandHandlers } = require("./bot/commands");
const { bindDiscordEvents } = require("./bot/events");
const { startWeb } = require("./web/server"); // attachRuntime 先不要用（你目前會炸）

async function main() {
  initFirebase();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // counting 需要
    ],
    partials: [Partials.Channel],
  });

  // 建立指令處理器
  makeCommandHandlers(client);

  // 綁事件（slash + counting message）
  bindDiscordEvents(client);

  // Web（可先開，後台再處理）
  startWeb();

  client.once("ready", async () => {
    console.log("[Discord] Logged in as", client.user.tag);
    await registerCommands();
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});