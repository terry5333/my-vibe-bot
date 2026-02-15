/**
 * ✅ Discord Developer Portal Intents 設定（必做）
 * 1) Developer Portal → Applications → Bot → Privileged Gateway Intents
 *    - ✅ MESSAGE CONTENT INTENT（必開：messageCreate 才抓得到玩家輸入）
 *    - ✅ SERVER MEMBERS INTENT（建議：身分組功能更穩）
 * 2) 程式端也必須包含 GatewayIntentBits.MessageContent（本檔已包含）
 *
 * ✅ Render 必須有 Express Server 維持運作（本檔已包含）
 * ✅ Firebase 認證從 process.env.FIREBASE_CONFIG 讀 JSON（本檔已處理 private_key 的 \\n）
 *
 * ✅ 絕不逾時策略
 * - 所有會碰 DB 的 interaction：一律 deferReply / deferUpdate
 * - DB 讀寫一律 async/await + try/catch
 */

"use strict";

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require("discord.js");
const admin = require("firebase-admin");

// =========================
// Express Keep-Alive (Render)
// =========================
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`[Express] Listening on :${PORT}`));

// =========================
// Discord Client
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // ✅ 必須
    GatewayIntentBits.GuildMembers,   // ✅ 建議
  ],
  partials: [Partials.Channel],
});

// =========================
// Firebase Init
// =========================
const FIREBASE_DB_URL = "https://my-pos-4eeee-default-rtdb.firebaseio.com/";

function parseFirebaseConfig() {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) throw new Error("Missing process.env.FIREBASE_CONFIG");
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_CONFIG is not valid JSON");
  }
  if (cfg.private_key && typeof cfg.private_key === "string") {
    cfg.private_key = cfg.private_key.replace(/\\n/g, "\n");
  }
  return cfg;
}

let db = null;
let dbReadyResolve;
let dbReadyReject;
const dbReady = new Promise((resolve, reject) => {
  dbReadyResolve = resolve;
  dbReadyReject = reject;
});

function initFirebase() {
  try {
    if (admin.apps.length === 0) {
      const serviceAccount = parseFirebaseConfig();
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: FIREBASE_DB_URL,
      });
    }
    db = admin.database();
    dbReadyResolve(true);
    console.log("[Firebase] Initialized");
  } catch (err) {
    console.error("[Firebase] Init failed:", err);
    dbReadyReject(err);
  }
}
initFirebase();

// =========================
// Leaderboard Cache (/rank 秒回)
// =========================
const leaderboardCache = { updatedAt: 0, top: [] }; // [{userId, points}]
const userPointsCache = new Map(); // userId -> points

async function refreshLeaderboardCache() {
  await dbReady;
  try {
    const snap = await db.ref("points").orderByValue().limitToLast(10).get();
    const val = snap.val() || {};
    const arr = Object.entries(val)
      .map(([userId, points]) => ({ userId, points: Number(points) || 0 }))
      .sort((a, b) => b.points - a.points);
    leaderboardCache.top = arr;
    leaderboardCache.updatedAt = Date.now();
  } catch (e) {
    console.error("[Cache] refreshLeaderboardCache failed:", e);
  }
}
setInterval(() => refreshLeaderboardCache().catch(() => {}), 20_000);

// =========================
// ✅ Points Core
// =========================
async function addPoints(userId, amount) {
  if (!userId) throw new Error("addPoints: missing userId");
  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta === 0) throw new Error("addPoints: invalid amount");

  await dbReady;

  const ref = db.ref(`points/${userId}`);
  const result = await ref.transaction((current) => {
    const cur = Number(current) || 0;
    return cur + delta;
  });

  if (!result.committed) throw new Error("addPoints: transaction not committed");

  const newPoints = Number(result.snapshot.val()) || 0;
  userPointsCache.set(userId, newPoints);
  bumpLeaderboardCache(userId, newPoints);
  return newPoints;
}

function bumpLeaderboardCache(userId, points) {
  const top = leaderboardCache.top.slice();
  const idx = top.findIndex((x) => x.userId === userId);
  if (idx >= 0) top[idx] = { userId, points };
  else top.push({ userId, points });
  top.sort((a, b) => b.points - a.points);
  leaderboardCache.top = top.slice(0, 10);
  leaderboardCache.updatedAt = Date.now();
}

async function getPoints(userId) {
  const cached = userPointsCache.get(userId);
  if (typeof cached === "number") return cached;

  await dbReady;
  const snap = await db.ref(`points/${userId}`).get();
  const pts = Number(snap.val()) || 0;
  userPointsCache.set(userId, pts);
  return pts;
}

// =========================
// Games State
// =========================
// Guess: per channel one game
const guessGame = new Map(); // channelId -> {active, answer, min, max}

// HL: per user one game (按鈕控制)
const hlGame = new Map(); // userId -> { current, streak }

// Counting: per channel one game
const countingGame = new Map(); // channelId -> { active, start, next, lastUserId, reward }

// =========================
// Commands
// =========================
const slashCommands = [
  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("啟動終極密碼（此頻道猜數字）")
    .addIntegerOption((o) => o.setName("min").setDescription("最小值").setRequired(false))
    .addIntegerOption((o) => o.setName("max").setDescription("最大值").setRequired(false)),

  new SlashCommandBuilder()
    .setName("hl")
    .setDescription("高低牌（按鈕猜 higher / lower）"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("查看排行榜（快取秒回）"),

  new SlashCommandBuilder()
    .setName("points")
    .setDescription("查看你的積分"),

  new SlashCommandBuilder()
    .setName("counting")
    .setDescription("Counting 遊戲")
    .addSubcommand((s) =>
      s.setName("start").setDescription("在此頻道啟動 counting")
        .addIntegerOption((o) => o.setName("start").setDescription("起始數字（預設 1）").setRequired(false))
        .addIntegerOption((o) => o.setName("reward").setDescription("每次正確加分（預設 1）").setRequired(false))
    )
    .addSubcommand((s) => s.setName("stop").setDescription("停止此頻道 counting"))
    .addSubcommand((s) => s.setName("status").setDescription("查看此頻道 counting 狀態")),
].map((c) => c.toJSON());

async function registerCommandsOnce() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    console.warn("[Commands] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID, skip registering.");
    return;
  }

  if (String(process.env.REGISTER_COMMANDS).toLowerCase() !== "true") {
    console.log("[Commands] REGISTER_COMMANDS != true, skip registering.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: slashCommands });
  console.log("[Commands] Registered global slash commands");
}

// =========================
// Helpers
// =========================
function randInt(min, max) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function hlButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("hl:higher").setLabel("Higher").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hl:lower").setLabel("Lower").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("hl:stop").setLabel("Stop").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

// =========================
// Discord Ready
// =========================
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);

  try {
    await registerCommandsOnce();
  } catch (e) {
    console.error("[Commands] register failed:", e);
  }

  await refreshLeaderboardCache();
});

// =========================
// interactionCreate
// =========================
client.on("interactionCreate", async (interaction) => {
  try {
    // ---- Slash Commands ----
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      // /points（你說沒反應：這裡保證先 defer）
      if (name === "points") {
        await interaction.deferReply({ ephemeral: true });
        const pts = await getPoints(interaction.user.id);
        return interaction.editReply(`你目前積分：**${pts}**`);
      }

      // /rank（秒回快取）
      if (name === "rank") {
        const top = leaderboardCache.top;
        const ageSec = Math.floor((Date.now() - leaderboardCache.updatedAt) / 1000);
        if (!top.length) return interaction.reply("排行榜目前沒有資料～先玩遊戲拿分吧！");
        const lines = top.map((x, i) => `**#${i + 1}** <@${x.userId}> — **${x.points}**`);
        return interaction.reply(`🏆 排行榜\n${lines.join("\n")}\n\n_快取更新：${ageSec}s 前_`);
      }

      // /guess（你說猜中沒跳訊息：我改成猜中「一定先回」）
      if (name === "guess") {
        await interaction.deferReply({ ephemeral: false });

        const channelId = interaction.channelId;
        const existing = guessGame.get(channelId);
        if (existing?.active) {
          return interaction.editReply(`此頻道已有終極密碼（${existing.min}~${existing.max}），直接在頻道輸入整數猜！`);
        }

        const min = interaction.options.getInteger("min") ?? 1;
        const max = interaction.options.getInteger("max") ?? 100;
        const realMin = Math.min(min, max);
        const realMax = Math.max(min, max);

        if (realMax - realMin < 2) {
          return interaction.editReply("範圍太小，至少要像 1~3 這樣答案才可能在中間。");
        }

        // ✅ 答案只落在 (min, max) 內，避免永遠猜不到
        const answer = randInt(realMin + 1, realMax - 1);

        guessGame.set(channelId, { active: true, answer, min: realMin, max: realMax });

        return interaction.editReply(
          `🎯 終極密碼開始！範圍：**${realMin} ~ ${realMax}**（不含邊界）\n直接在此頻道輸入整數猜。猜中 +50 分！`
        );
      }

      // /hl（你說猜對沒反應：按鈕那邊我全部用 deferUpdate + editReply）
      if (name === "hl") {
        await interaction.deferReply({ ephemeral: false });

        const userId = interaction.user.id;
        const current = randInt(1, 13);
        hlGame.set(userId, { current, streak: 0 });

        return interaction.editReply({
          content: `🃏 高低牌開始！目前牌：**${current}**（1~13）\n猜對每回合 +5 分`,
          components: hlButtons(),
        });
      }

      // /counting（新增 counting）
      if (name === "counting") {
        if (!interaction.inGuild()) return interaction.reply({ content: "此指令只能在伺服器使用。", ephemeral: true });

        const sub = interaction.options.getSubcommand();
        const channelId = interaction.channelId;

        await interaction.deferReply({ ephemeral: true });

        if (sub === "start") {
          const start = interaction.options.getInteger("start") ?? 1;
          const reward = interaction.options.getInteger("reward") ?? 1;

          if (!Number.isInteger(start)) return interaction.editReply("start 必須是整數。");
          if (!Number.isInteger(reward) || reward <= 0) return interaction.editReply("reward 必須是正整數。");

          countingGame.set(channelId, {
            active: true,
            start,
            next: start,
            lastUserId: null,
            reward,
          });

          await interaction.channel.send(
            `🔢 Counting 已啟動！請從 **${start}** 開始依序輸入。\n規則：同一人不能連續｜正確 +${reward} 分`
          );
          return interaction.editReply("已啟動 counting。");
        }

        if (sub === "stop") {
          countingGame.delete(channelId);
          await interaction.channel.send("🛑 Counting 已停止。");
          return interaction.editReply("已停止 counting。");
        }

        if (sub === "status") {
          const s = countingGame.get(channelId);
          if (!s?.active) return interaction.editReply("此頻道目前沒有啟用 counting。");
          return interaction.editReply(
            `✅ Counting 啟用中\n下一個：**${s.next}**｜起始：${s.start}｜reward：+${s.reward}`
          );
        }
      }
    }

    // ---- Buttons ----
    if (interaction.isButton()) {
      const id = interaction.customId;

      // HL buttons
      if (id.startsWith("hl:")) {
        const userId = interaction.user.id;
        const state = hlGame.get(userId);

        if (!state) {
          return interaction.reply({ content: "你沒有正在進行的高低牌，請用 /hl 開始。", ephemeral: true });
        }

        const action = id.split(":")[1];

        if (action === "stop") {
          hlGame.delete(userId);
          return interaction.update({ content: `🛑 已結束。連勝：**${state.streak}**`, components: [] });
        }

        const next = randInt(1, 13);
        const guessHigher = action === "higher";
        const ok =
          (guessHigher && next > state.current) ||
          (!guessHigher && next < state.current);

        if (!ok) {
          hlGame.delete(userId);
          return interaction.update({
            content: `❌ 猜錯！${state.current} → ${next}\n連勝停在：**${state.streak}**`,
            components: [],
          });
        }

        // ✅ 先 deferUpdate，避免「按鈕沒反應」
        await interaction.deferUpdate();

        state.streak += 1;
        state.current = next;

        let newPts = null;
        try {
          newPts = await addPoints(userId, 5); // ✅ 寫入成功才算
        } catch (e) {
          console.error("[HL] addPoints failed:", e);
        }

        return interaction.editReply({
          content:
            newPts !== null
              ? `✅ 猜對！+5 分（總分：**${newPts}**）\n目前牌：**${state.current}**｜連勝：**${state.streak}**`
              : `✅ 猜對！但加分失敗（請管理員查 log/Firebase）\n目前牌：**${state.current}**｜連勝：**${state.streak}**`,
          components: hlButtons(),
        });
      }
    }
  } catch (e) {
    console.error("[interactionCreate] error:", e);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("發生錯誤，請稍後再試。");
        } else {
          await interaction.reply({ content: "發生錯誤，請稍後再試。", ephemeral: true });
        }
      }
    } catch {}
  }
});

// =========================
// messageCreate (Guess + Counting)
// =========================
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const channelId = message.channel.id;

    // ---- Guess ----
    const g = guessGame.get(channelId);
    if (g?.active) {
      const t = message.content.trim();
      if (/^-?\d+$/.test(t)) {
        const n = Number(t);
        if (!Number.isInteger(n)) return;

        if (n <= g.min || n >= g.max) {
          await message.reply(`請猜 **${g.min} ~ ${g.max}** 之間（不含邊界）。`);
          return;
        }

        if (n === g.answer) {
          guessGame.delete(channelId);

          // ✅ 先回「猜中正在加分」確保一定跳訊息
          await message.reply(`🎉 猜中！答案是 **${g.answer}**\n正在加分中…`);

          try {
            const newPts = await addPoints(message.author.id, 50);
            await message.channel.send(`<@${message.author.id}> +50 分 ✅（總分：**${newPts}**）`);
          } catch (e) {
            console.error("[Guess] addPoints failed:", e);
            await message.channel.send(`<@${message.author.id}> 你應得 +50 分，但加分失敗（請管理員查 log/Firebase）`);
          }
          return;
        }

        if (n < g.answer) {
          g.min = n;
          await message.reply(`太小了！新範圍：**${g.min} ~ ${g.max}**`);
          return;
        } else {
          g.max = n;
          await message.reply(`太大了！新範圍：**${g.min} ~ ${g.max}**`);
          return;
        }
      }
    }

    // ---- Counting ----
    const c = countingGame.get(channelId);
    if (c?.active) {
      const t = message.content.trim();
      if (!/^-?\d+$/.test(t)) return;

      const n = Number(t);
      if (!Number.isInteger(n)) return;

      if (c.lastUserId === message.author.id) {
        await message.reply("⛔ 同一個人不能連續兩次！請換別人接。");
        return;
      }

      if (n !== c.next) {
        c.next = c.start;
        c.lastUserId = null;
        await message.reply(`❌ 錯了！已重置，請從 **${c.start}** 重新開始。`);
        return;
      }

      // 正確
      c.lastUserId = message.author.id;
      c.next += 1;

      try {
        await addPoints(message.author.id, c.reward);
        await message.react("✅").catch(() => {});
      } catch (e) {
        console.error("[Counting] addPoints failed:", e);
        await message.reply("✅ 數字正確，但加分失敗（請管理員查 log/Firebase）");
      }
      return;
    }
  } catch (e) {
    console.error("[messageCreate] error:", e);
  }
});

// =========================
// Login
// =========================
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing process.env.DISCORD_TOKEN");
  process.exit(1);
}
client.login(token);
