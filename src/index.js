"use strict";

const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");

const { commandData, makeCommandHandlers } = require("./bot/commands");
const { registerCommands } = require("./bot/registerCommands");
const gamesMod = require("./bot/games");

// 你的 firebase 有就留，沒有就刪掉
const firebase = require("./db/firebase");

async function safeRespond(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }
    return await interaction.reply(payload);
  } catch (_) {
    // 避免 10062/40060 讓程式炸掉
  }
}

async function main() {
  // Firebase（可選）
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

  process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
  process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
  client.on("error", (err) => console.error("[client error]", err));

  const handlers = makeCommandHandlers({ client });

  client.once(Events.ClientReady, async () => {
    console.log(`[Discord] Logged in as ${client.user.tag}`);

    try {
      await registerCommands(commandData);
      console.log("[Commands] registered");
    } catch (e) {
      console.error("[Commands] register failed:", e);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ✅ 一進來就 ack（避免 10062）
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: false }); // 公開
      }
    } catch (_) {}

    const fn = handlers[interaction.commandName];
    if (!fn) {
      await safeRespond(interaction, { content: "❌ 這個指令沒有處理器。" });
      return;
    }

    try {
      await fn(interaction);
    } catch (err) {
      console.error("[interactionCreate] error:", err);
      // ✅ 這裡永遠只 editReply，不會第二次 reply
      await safeRespond(interaction, { content: "❌ 指令執行出錯，請稍後再試。" });
    }
  });

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