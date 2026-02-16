"use strict";

/**
 * src/index.js
 * ✅ 不再使用 makeCommandHandlers
 * ✅ 使用：registerCommands() + bindDiscordEvents()
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { initFirebase } = require("./db/firebase");
const { registerCommands } = require("./bot/registerCommands");
const { bindDiscordEvents } = require("./bot/events");
const { startWeb } = require("./web/server");

async function main() {
  // Firebase
  initFirebase();

  // Discord Client
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // ✅ counting/guess 要讀訊息
    ],
    partials: [Partials.Channel],
  });

  // Web
  const webRuntime = startWeb(); // 你 server.js 只有 export { startWeb, app } 就這樣用

  // 綁事件（Slash / messageCreate 都在這）
  bindDiscordEvents(client, webRuntime);

  client.once("ready", async () => {
    console.log("[Discord] Logged in as", client.user.tag);

    // 註冊 Slash（全域可能要等幾分鐘）
    await registerCommands();
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});