"use strict";

/**
 * ✅ Discord Developer Portal Intents 設定（不然文字遊戲會失效）
 * 1) 到 Developer Portal -> Bot -> Privileged Gateway Intents
 * 2) 開啟：
 *    - MESSAGE CONTENT INTENT（必要，終極密碼/counting 需要讀訊息內容）
 *    - SERVER MEMBERS INTENT（可選，想拿更完整玩家資訊可開）
 * 3) 程式端 intents 也必須包含 GatewayIntentBits.MessageContent
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { initFirebase } = require("./db/firebase");
const { registerCommands } = require("./bot/commands");
const { bindDiscordEvents } = require("./bot/events");
const { startWeb, attachRuntime } = require("./web/server");

async function main() {
  initFirebase();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // ✅ 必須
    ],
    partials: [Partials.Channel],
  });

  // Web 先開（Railway/Render 要用）
  const webRuntime = startWeb();
  attachRuntime(webRuntime, { client });

  bindDiscordEvents(client, webRuntime);

  client.once("ready", async () => {
    console.log("[Discord] Logged in as", client.user.tag);

    // 自動註冊 Slash Commands（global 可能需要幾分鐘才生效；有 GUILD_ID 會秒生效）
    await registerCommands();
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
