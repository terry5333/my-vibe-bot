"use strict";

/**
 * ✅ Discord Developer Portal Intents 設定（必做）
 * 1) Developer Portal → Applications → Bot → Privileged Gateway Intents
 *    - ✅ MESSAGE CONTENT INTENT（必開：messageCreate 才抓得到玩家輸入）
 *    - ✅ SERVER MEMBERS INTENT（建議）
 * 2) 程式端也必須包含 GatewayIntentBits.MessageContent（本檔已包含）
 *
 * ✅ Render：必須開 Express Server（本檔已包含）
 * ✅ Firebase：從 process.env.FIREBASE_CONFIG 讀取 service account JSON（本檔已處理 private_key 的 \\n）
 */

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
} = require("discord.js");
const admin = require("firebase-admin");

// =========================
// Express (Render keep alive + Admin Page)
// =========================
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.status(200).send("OK"));

function requireAdminToken(req) {
  const expected = process.env.ADMIN_TOKEN || "";
  const token =
    (req.query.token || "") ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return !!expected && token === expected;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// =========================
// Discord Client
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // ✅ 必須
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
// Points Core
// =========================
const leaderboardCache = { updatedAt: 0, top: [] }; // /rank 秒回
const userPointsCache = new Map();

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

  const newPts = Number(result.snapshot.val()) || 0;
  userPointsCache.set(userId, newPts);
  bumpLeaderboardCache(userId, newPts);
  return newPts;
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
// ✅ Admin Web Page
// =========================
app.get("/admin", async (req, res) => {
  if (!requireAdminToken(req)) return res.status(401).send("Unauthorized");

  await dbReady;

  const token = esc(req.query.token || "");
  const qUserId = String(req.query.userId || "").trim();

  let userPoints = null;
  if (qUserId) {
    const snap = await db.ref(`points/${qUserId}`).get();
    userPoints = Number(snap.val()) || 0;
  }

  // Top 50
  const snap = await db.ref("points").orderByValue().limitToLast(50).get();
  const val = snap.val() || {};
  const top = Object.entries(val)
    .map(([userId, points]) => ({ userId, points: Number(points) || 0 }))
    .sort((a, b) => b.points - a.points);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Admin - Points</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 16px; }
    .box { border: 1px solid #ddd; padding: 12px; border-radius: 10px; margin-bottom: 12px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { background: #f5f5f5; text-align: left; }
    input { padding: 8px; width: 360px; max-width: 100%; }
    button { padding: 8px 12px; }
    code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <h2>Points Admin</h2>

  <div class="box">
    <div>網址格式：<code>/admin?token=ADMIN_TOKEN</code></div>
    <div>查詢玩家：<code>/admin?token=...&userId=...</code></div>
  </div>

  <div class="box">
    <h3>查詢玩家</h3>
    <form method="GET" action="/admin">
      <input type="hidden" name="token" value="${token}" />
      <input name="userId" placeholder="Discord User ID" value="${esc(qUserId)}" />
      <button type="submit">查詢</button>
    </form>
    ${
      qUserId
        ? `<p>userId: <code>${esc(qUserId)}</code> points: <b>${userPoints}</b></p>`
        : `<p>輸入 userId 查詢單人分數</p>`
    }
  </div>

  <div class="box">
    <h3>加分 / 扣分（扣分用負數）</h3>
    <form method="POST" action="/admin/adjust?token=${token}">
      <div><input name="userId" placeholder="Discord User ID" required /></div><br/>
      <div><input name="amount" placeholder="Amount (e.g. 50 or -10)" required /></div><br/>
      <button type="submit">送出</button>
    </form>
  </div>

  <div class="box">
    <h3>Top 50</h3>
    <table>
      <tr><th>#</th><th>User ID</th><th>Points</th></tr>
      ${top
        .map(
          (x, i) =>
            `<tr><td>${i + 1}</td><td><code>${esc(x.userId)}</code></td><td><b>${x.points}</b></td></tr>`
        )
        .join("")}
    </table>
  </div>
</body>
</html>`);
});

app.post("/admin/adjust", async (req, res) => {
  if (!requireAdminToken(req)) return res.status(401).send("Unauthorized");

  const userId = String(req.body.userId || "").trim();
  const amount = Number(req.body.amount);

  if (!userId) return res.status(400).send("Missing userId");
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).send("Invalid amount");

  try {
    await addPoints(userId, amount);
    return res.redirect(
      `/admin?token=${encodeURIComponent(req.query.token)}&userId=${encodeURIComponent(userId)}`
    );
  } catch (e) {
    console.error("[AdminAdjust] Failed:", e);
    return res.status(500).send("Adjust failed");
  }
});

// =========================
// Discord Slash Commands
// =========================
const commands = [
  new SlashCommandBuilder().setName("points").setDescription("查看你的積分"),
  new SlashCommandBuilder().setName("rank").setDescription("查看排行榜（快取秒回）"),
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
  if (!token || !clientId) return;

  if (String(process.env.REGISTER_COMMANDS).toLowerCase() !== "true") return;

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("[Commands] Registered global slash commands");
}

// =========================
// Counting Game State
// =========================
const countingGame = new Map(); // channelId -> {active, start, next, lastUserId, reward}

// =========================
// Discord Events
// =========================
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  try {
    await registerCommandsOnce();
  } catch (e) {
    console.error("[Commands] Register failed:", e);
  }
  await refreshLeaderboardCache();
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "points") {
      await interaction.deferReply({ ephemeral: true });
      const pts = await getPoints(interaction.user.id);
      return interaction.editReply(`你目前積分：**${pts}**`);
    }

    if (interaction.commandName === "rank") {
      const top = leaderboardCache.top;
      const ageSec = Math.floor((Date.now() - leaderboardCache.updatedAt) / 1000);
      if (!top.length) return interaction.reply("排行榜目前沒有資料。");

      const lines = top.map((x, i) => `**#${i + 1}** <@${x.userId}> — **${x.points}**`);
      return interaction.reply(`🏆 排行榜\n${lines.join("\n")}\n\n_快取更新：${ageSec}s 前_`);
    }

    if (interaction.commandName === "counting") {
      const sub = interaction.options.getSubcommand();
      const channelId = interaction.channelId;

      await interaction.deferReply({ ephemeral: true });

      if (sub === "start") {
        const start = interaction.options.getInteger("start") ?? 1;
        const reward = interaction.options.getInteger("reward") ?? 1;

        countingGame.set(channelId, {
          active: true,
          start,
          next: start,
          lastUserId: null,
          reward,
        });

        await interaction.channel.send(
          `🔢 Counting 已啟動！請從 **${start}** 開始。\n規則：同一人不能連續｜正確 +${reward} 分`
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
        if (!s?.active) return interaction.editReply("此頻道未啟用 counting。");
        return interaction.editReply(`✅ 下一個：**${s.next}**｜reward：+${s.reward}`);
      }
    }
  } catch (e) {
    console.error("[interactionCreate] Error:", e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("發生錯誤，請稍後再試。");
      } else {
        await interaction.reply({ content: "發生錯誤，請稍後再試。", ephemeral: true });
      }
    } catch {}
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const state = countingGame.get(channelId);
    if (!state?.active) return;

    const t = message.content.trim();
    if (!/^-?\d+$/.test(t)) return;

    const n = Number(t);
    if (!Number.isInteger(n)) return;

    if (state.lastUserId === message.author.id) {
      await message.reply("⛔ 同一人不能連續兩次！");
      return;
    }

    if (n !== state.next) {
      state.next = state.start;
      state.lastUserId = null;
      await message.reply(`❌ 錯了！已重置，請從 **${state.start}** 重新開始。`);
      return;
    }

    // 正確
    state.lastUserId = message.author.id;
    state.next += 1;

    await addPoints(message.author.id, state.reward);
    await message.react("✅").catch(() => {});
  } catch (e) {
    console.error("[messageCreate] Error:", e);
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
