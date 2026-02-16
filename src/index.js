"use strict";

const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");

const { commandData, makeCommandHandlers } = require("./bot/commands");
const { registerCommands } = require("./bot/registerCommands");
const gamesMod = require("./bot/games"); // { games, onMessage }
const firebase = require("./db/firebase"); // 你原本有的話保留，沒有就刪掉

async function main() {
  // Firebase（如果你專案有用）
  try {
    if (firebase?.init) await firebase.init();
    console.log("[Firebase] Initialized");
  } catch (e) {
    console.log("[Firebase] init skipped:", e?.message || e);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  // ✅ 準備指令處理器
  const handlers = makeCommandHandlers({ client });

  client.once(Events.ClientReady, async () => {
    console.log(`[Discord] Logged in as ${client.user.tag}`);

    // ✅ 註冊 slash 指令（global）
    try {
      await registerCommands(commandData);
      console.log("[Commands] registered");
      console.log("[Commands] Registered GLOBAL slash commands");
    } catch (e) {
      console.error("[Commands] register failed:", e);
    }
  });

  // ✅ slash 指令入口：只交給 handlers，不要在這裡 reply/defer
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      const fn = handlers[interaction.commandName];
      if (!fn) {
        // 這裡也不要 reply 第二次，如果你怕沒處理，可以只做一次 reply
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "❌ 這個指令目前沒有處理器。", ephemeral: true });
        }
        return;
      }
      await fn(interaction);
    } catch (err) {
      console.error("[interactionCreate] error:", err);
      // 防止再 reply 造成 40060
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ 指令執行出錯，請稍後再試。", ephemeral: true });
      }
    }
  });

  // ✅ 遊戲訊息入口（counting / guess 用「直接輸入數字」）
  client.on(Events.MessageCreate, async (msg) => {
    try {
      await gamesMod?.onMessage?.(msg);
    } catch (e) {
      console.error("[messageCreate] error:", e);
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});