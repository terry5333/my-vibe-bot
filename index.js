/**
 * ✅ Discord Developer Portal Intents 設定（非常重要，否則文字遊戲會失效）
 * 1) https://discord.com/developers/applications → 選你的 Bot → Bot 分頁
 * 2) Privileged Gateway Intents 開啟：
 *    - ✅ MESSAGE CONTENT INTENT   （必開：messageCreate 要讀到玩家輸入）
 *    - ✅ SERVER MEMBERS INTENT    （建議：身分組/管理功能更穩）
 * 3) 程式端也必須包含 GatewayIntentBits.MessageContent（本檔案已包含）
 *
 * ✅ Render 需要 Express Server 維持運作（本檔案已包含）
 * ✅ Firebase 從 process.env.FIREBASE_CONFIG 讀取 service account JSON（本檔案已處理 \n）
 *
 * ✅ 絕不逾時策略（嚴格遵守）
 * - 所有 DB 讀寫：async/await
 * - 所有互動：deferReply / deferUpdate
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
// Express (Render keep-alive + Admin page)
// =========================
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.status(200).send("OK"));

// --- Admin token auth ---
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
    GatewayIntentBits.MessageContent, // ✅ 必須：文字遊戲需要
    GatewayIntentBits.GuildMembers, // ✅ 建議：身分組更穩
  ],
  partials: [Partials.Channel],
});

// =========================
// Firebase Init (Realtime DB)
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
// Cache (Leaderboard must be in-memory)
// =========================
const leaderboardCache = {
  updatedAt: 0,
  top: [], // [{ userId, points }]
};

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

setInterval(() => {
  refreshLeaderboardCache().catch(() => {});
}, 20_000);

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
// Admin page (view + adjust)
// =========================
app.get("/admin", async (req, res) => {
  if (!requireAdminToken(req)) return res.status(401).send("Unauthorized");

  await dbReady;

  const qUserId = String(req.query.userId || "").trim();
  let userPoints = null;

  if (qUserId) {
    const s = await db.ref(`points/${qUserId}`).get();
    userPoints = Number(s.val()) || 0;
  }

  const snap = await db.ref("points").orderByValue().limitToLast(50).get();
  const val = snap.val() || {};
  const top = Object.entries(val)
    .map(([userId, points]) => ({ userId, points: Number(points) || 0 }))
    .sort((a, b) => b.points - a.points);

  const token = esc(req.query.token || "");

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
    <div>開啟方式：<code>/admin?token=ADMIN_TOKEN</code></div>
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

// ✅ 只 listen 一次
app.listen(PORT, () => console.log(`[Express] Listening on :${PORT}`));

// =========================
// Game State
// =========================
const gameData = new Map(); // guess: channelId -> { active, answer, min, max }
const hlGames = new Map(); // hl: userId -> { current, streak }

// counting: channelId -> { active, start, next, lastUserId, reward }
const countingData = new Map();
const COUNTING_PATH = "counting";

// =========================
// Slash Commands
// =========================
const slashCommands = [
  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("啟動終極密碼遊戲（在此頻道猜數字）")
    .addIntegerOption((o) => o.setName("min").setDescription("最小值").setRequired(false))
    .addIntegerOption((o) => o.setName("max").setDescription("最大值").setRequired(false)),

  new SlashCommandBuilder()
    .setName("hl")
    .setDescription("啟動高低牌遊戲（按鈕猜 higher / lower）"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("查看排行榜（快取秒回）"),

  new SlashCommandBuilder()
    .setName("points")
    .setDescription("查看你目前的積分"),

  new SlashCommandBuilder()
    .setName("setup-role")
    .setDescription("產生身分組切換按鈕（有則移除，無則加入）")
    .addRoleOption((o) => o.setName("role").setDescription("要切換的身分組").setRequired(true))
    .addStringOption((o) => o.setName("label").setDescription("按鈕顯示文字（可選）").setRequired(false)),

  new SlashCommandBuilder()
    .setName("counting")
    .setDescription("Counting 遊戲控制")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("在此頻道啟動 counting")
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
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: slashCommands });
    console.log("[Commands] Registered global slash commands");
  } catch (e) {
    console.error("[Commands] Register failed:", e);
  }
}

// =========================
// Helpers
// =========================
function randInt(min, max) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function makeHLButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("hl:higher").setLabel("Higher").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hl:lower").setLabel("Lower").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("hl:stop").setLabel("Stop").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function loadCountingState(guildId, channelId) {
  await dbReady;
  const snap = await db.ref(`${COUNTING_PATH}/${guildId}/${channelId}`).get();
  const v = snap.val();
  if (!v || !v.active) return null;
  return {
    active: true,
    start: Number(v.start) || 1,
    next: Number(v.next) || Number(v.start) || 1,
    lastUserId: v.lastUserId || null,
    reward: Number(v.reward) || 1,
  };
}

async function saveCountingState(guildId, channelId, state) {
  await dbReady;
  await db.ref(`${COUNTING_PATH}/${guildId}/${channelId}`).set({
    active: !!state.active,
    start: state.start,
    next: state.next,
    lastUserId: state.lastUserId || null,
    reward: state.reward,
    updatedAt: Date.now(),
  });
}

async function stopCountingState(guildId, channelId) {
  await dbReady;
  await db.ref(`${COUNTING_PATH}/${guildId}/${channelId}`).set({
    active: false,
    updatedAt: Date.now(),
  });
}

// =========================
// Discord Events
// =========================
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await registerCommandsOnce();
  await refreshLeaderboardCache();
});

// ---------- Interactions ----------
client.on("interactionCreate", async (interaction) => {
  try {
    // ===== Slash commands =====
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === "guess") {
        await interaction.deferReply({ ephemeral: false });

        const channelId = interaction.channelId;
        const existing = gameData.get(channelId);
        if (existing?.active) {
          return interaction.editReply(
            `此頻道已經有終極密碼（${existing.min}~${existing.max}），直接在頻道輸入整數猜吧！`
          );
        }

        const min = interaction.options.getInteger("min") ?? 1;
        const max = interaction.options.getInteger("max") ?? 100;
        const realMin = Math.min(min, max);
        const realMax = Math.max(min, max);

        // ✅ 修正：答案不會落在邊界，避免永遠猜不到
        if (realMax - realMin < 2) {
          return interaction.editReply("範圍太小，至少要像 1~3 這樣答案才可能落在中間。");
        }

        const answer = randInt(realMin + 1, realMax - 1);

        gameData.set(channelId, {
          active: true,
          answer,
          min: realMin,
          max: realMax,
        });

        return interaction.editReply(
          `🎯 終極密碼開始！範圍：**${realMin} ~ ${realMax}**（不含邊界）\n猜中者 +50 分！`
        );
      }

      if (name === "hl") {
        await interaction.deferReply({ ephemeral: false });

        const userId = interaction.user.id;
        const current = randInt(1, 13);
        hlGames.set(userId, { current, streak: 0 });

        return interaction.editReply({
          content: `🃏 高低牌開始！目前牌：**${current}**（1~13）\n猜對每回合 +5 分`,
          components: makeHLButtons(),
        });
      }

      if (name === "rank") {
        const top = leaderboardCache.top;
        const ageSec = Math.floor((Date.now() - leaderboardCache.updatedAt) / 1000);

        if (!top.length) return interaction.reply("排行榜目前沒有資料～先玩遊戲拿分吧！");

        const lines = top.map((x, i) => `**#${i + 1}** <@${x.userId}> — **${x.points}**`);
        return interaction.reply(`🏆 排行榜\n${lines.join("\n")}\n\n_快取更新：${ageSec}s 前_`);
      }

      if (name === "points") {
        await interaction.deferReply({ ephemeral: true });
        const pts = await getPoints(interaction.user.id);
        return interaction.editReply(`你目前的積分是：**${pts}**`);
      }

      if (name === "setup-role") {
        await interaction.deferReply({ ephemeral: true });

        if (!interaction.inGuild()) return interaction.editReply("此指令只能在伺服器使用。");

        const role = interaction.options.getRole("role");
        const label = interaction.options.getString("label") || `切換身分組：${role.name}`;

        const me = interaction.guild.members.me;
        if (!me) return interaction.editReply("我讀不到自己的成員資訊，請稍後再試。");

        if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          return interaction.editReply("我沒有 **Manage Roles** 權限。");
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`role:toggle:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary)
        );

        await interaction.channel.send({
          content: `🔘 點按鈕切換：<@&${role.id}>`,
          components: [row],
        });

        return interaction.editReply("已送出按鈕。");
      }

      if (name === "counting") {
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "此指令只能在伺服器使用。", ephemeral: true });
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;

        await interaction.deferReply({ ephemeral: true });

        if (sub === "start") {
          const start = interaction.options.getInteger("start") ?? 1;
          const reward = interaction.options.getInteger("reward") ?? 1;

          if (!Number.isInteger(start)) return interaction.editReply("start 必須是整數");
          if (!Number.isInteger(reward) || reward <= 0) return interaction.editReply("reward 必須是正整數");

          const state = { active: true, start, next: start, lastUserId: null, reward };
          countingData.set(channelId, state);
          await saveCountingState(guildId, channelId, state);

          await interaction.channel.send(
            `🔢 Counting 已啟動！請從 **${start}** 開始。\n規則：同一人不能連續｜正確 +${reward} 分`
          );
          return interaction.editReply("已啟動 counting。");
        }

        if (sub === "stop") {
          countingData.delete(channelId);
          await stopCountingState(guildId, channelId);
          await interaction.channel.send("🛑 Counting 已停止。");
          return interaction.editReply("已停止 counting。");
        }

        if (sub === "status") {
          const s = countingData.get(channelId) || (await loadCountingState(guildId, channelId));
          if (!s?.active) return interaction.editReply("此頻道沒有啟用 counting。");
          countingData.set(channelId, s);
          return interaction.editReply(
            `✅ Counting 啟用中\n下一個：**${s.next}**｜起始：${s.start}｜reward：+${s.reward}`
          );
        }
      }
    }

    // ===== Buttons =====
    if (interaction.isButton()) {
      const id = interaction.customId;

      // HL
      if (id.startsWith("hl:")) {
        const userId = interaction.user.id;
        const state = hlGames.get(userId);

        if (!state) {
          return interaction.reply({ content: "你沒有正在進行的 /hl，請先開始。", ephemeral: true });
        }

        const action = id.split(":")[1];
        if (action === "stop") {
          hlGames.delete(userId);
          return interaction.update({ content: `🛑 已結束。連勝：**${state.streak}**`, components: [] });
        }

        const next = randInt(1, 13);
        const guessHigher = action === "higher";
        const ok = (guessHigher && next > state.current) || (!guessHigher && next < state.current);
