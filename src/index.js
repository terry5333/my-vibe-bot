"use strict";

const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");

const { commandData, makeCommandHandlers } = require("./bot/commands");
const { registerCommands } = require("./bot/registerCommands");
const gamesMod = require("./bot/games");

const firebase = require("./db/firebase"); // 沒有就刪掉這行與下面 init

async function safeReply(interaction, payload) {
  try {
    // payload 可以是 { content, ephemeral } 或 embeds 等
    if (interaction.deferred) return await interaction.editReply(payload);
    if (interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch (e) {
    // 這裡吞掉，避免再噴 40060 把 bot 弄掛
  }
}

async function main() {
  // Firebase（如果有）
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

  // ✅ 全域防炸（避免 Unhandled 'error' event）
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

  // ✅ 只留「一個」interactionCreate
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const fn = handlers[interaction.commandName];
    if (!fn) {
      await safeReply(interaction, { content: "❌ 這個指令沒有處理器。", ephemeral: true });
      return;
    }

    try {
      await fn(interaction);
    } catch (err) {
      console.error("[interactionCreate] error:", err);
      await safeReply(interaction, { content: "❌ 指令執行出錯，請稍後再試。", ephemeral: true });
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