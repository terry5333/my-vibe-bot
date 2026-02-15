/**
 * Intents（必做）
 * Developer Portal → Bot → Privileged Gateway Intents：
 *  - ✅ MESSAGE CONTENT INTENT（必開：messageCreate 才能讀數字）
 *  - ✅ SERVER MEMBERS INTENT（建議：setup-role 更穩）
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
// Express (keep-alive + Admin page)
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

app.listen(PORT, () => console.log(`[Express] Listening on :${PORT}`));

// =========================
// Discord Client
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // ✅ 必須
    GatewayIntentBits.GuildMembers, // ✅ 建議
  ],
  partials: [Partials.Channel],
});

// =========================
// Firebase Init
// =========================
const FIREBASE_DB_URL =
  "https://my-pos-4eeee-default-rtdb.asia-southeast1.firebasedatabase.app/";

function parseFirebaseConfig() {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) throw new Error("Missing process.env.FIREBASE_CONFIG");
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_CONFIG must be ONE LINE valid JSON");
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
// Cache (rank 秒回)
// =========================
const leaderboardCache = { updatedAt: 0, top: [] };
const userPointsCache = new Map();

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

function bumpLeaderboardCache(userId, points) {
  const top = leaderboardCache.top.slice();
  const idx = top.findIndex((x) => x.userId === userId);
  if (idx >= 0) top[idx] = { userId, points };
  else top.push({ userId, points });
  top.sort((a, b) => b.points - a.points);
  leaderboardCache.top = top.slice(0, 10);
  leaderboardCache.updatedAt = Date.now();
}

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

  const newPts = Number(result.snapshot.val()) || 0;
  userPointsCache.set(userId, newPts);
  bumpLeaderboardCache(userId, newPts);
  return newPts;
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
// Game State
// =========================
// ✅ 同一頻道「數字遊戲」只能有一個：guess 或 counting
const guessGame = new Map(); // channelId -> { active, answer, min, max }
const countingGame = new Map(); // channelId -> { active, start, next, lastUserId, reward, guildId }
const hlGame = new Map(); // userId -> { current, streak }

// counting persistence
const COUNTING_PATH = "counting";
const countingStoppedAt = new Map(); // channelId -> timestamp (避免 stop 後又被 DB load 回來)
const STOP_BLOCK_MS = 60_000; // 停止後 60 秒內不再從 DB 重新載入

function isGuessActive(channelId) {
  const g = guessGame.get(channelId);
  return !!g?.active;
}
function isCountingActive(channelId) {
  const c = countingGame.get(channelId);
  return !!c?.active;
}
function anyNumberGameActive(channelId) {
  return isGuessActive(channelId) || isCountingActive(channelId);
}

// =========================
// Counting DB helpers
// =========================
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
    guildId,
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
// Slash Commands
// =========================
const commandJSON = [
  new SlashCommandBuilder().setName("points").setDescription("查看你的積分"),
  new SlashCommandBuilder().setName("rank").setDescription("查看排行榜（快取秒回）"),

  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("啟動終極密碼（此頻道猜數字）")
    .addIntegerOption((o) => o.setName("min").setDescription("最小值").setRequired(false))
    .addIntegerOption((o) => o.setName("max").setDescription("最大值").setRequired(false)),

  new SlashCommandBuilder().setName("hl").setDescription("高低牌（按鈕猜 higher / lower）"),

  new SlashCommandBuilder()
    .setName("counting")
    .setDescription("Counting 遊戲")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("在此頻道啟動 counting")
        .addIntegerOption((o) => o.setName("start").setDescription("起始數字（預設 1）").setRequired(false))
        .addIntegerOption((o) => o.setName("reward").setDescription("每次正確加分（預設 1）").setRequired(false))
    )
    .addSubcommand((s) => s.setName("stop").setDescription("停止此頻道 counting"))
    .addSubcommand((s) => s.setName("status").setDescription("查看此頻道 counting 狀態")),

  new SlashCommandBuilder()
    .setName("setup-role")
    .setDescription("產生身分組切換按鈕（有則移除，無則加入）")
    .addRoleOption((o) => o.setName("role").setDescription("要切換的身分組").setRequired(true))
    .addStringOption((o) => o.setName("label").setDescription("按鈕文字（可選）").setRequired(false)),
].map((c) => c.toJSON());

async function registerCommandsOnce() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  console.log("[Commands] REGISTER_COMMANDS =", process.env.REGISTER_COMMANDS);

  if (!token || !clientId) {
    console.warn("[Commands] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID, skip.");
    return;
  }

  if (String(process.env.REGISTER_COMMANDS).toLowerCase() !== "true") {
    console.log("[Commands] REGISTER_COMMANDS != true, skip registering.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commandJSON });
    console.log("[Commands] Registered global slash commands");
  } catch (e) {
    console.error("[Commands] Register failed:", e);
  }
}

// =========================
// HL helpers
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

// =========================
// Admin Web Page (View + Adjust + Force Stop)
// =========================
async function listCountingActiveFromDB() {
  await dbReady;
  const snap = await db.ref(COUNTING_PATH).get();
  const root = snap.val() || {};
  // root: { guildId: { channelId: { active, next, ... } } }
  const rows = [];
  for (const [guildId, channels] of Object.entries(root)) {
    if (!channels) continue;
    for (const [channelId, state] of Object.entries(channels)) {
      if (state && state.active) {
        rows.push({
          guildId,
          channelId,
          next: Number(state.next) || Number(state.start) || 1,
          start: Number(state.start) || 1,
          reward: Number(state.reward) || 1,
          lastUserId: state.lastUserId || "",
          updatedAt: Number(state.updatedAt) || 0,
        });
      }
    }
  }
  rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return rows;
}

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

  const snap = await db.ref("points").orderByValue().limitToLast(50).get();
  const val = snap.val() || {};
  const top = Object.entries(val)
    .map(([userId, points]) => ({ userId, points: Number(points) || 0 }))
    .sort((a, b) => b.points - a.points);

  const guessRooms = [...guessGame.entries()]
    .filter(([, g]) => g?.active)
    .map(([channelId, g]) => ({ channelId, min: g.min, max: g.max }));

  const hlPlayers = [...hlGame.entries()].map(([userId, s]) => ({
    userId,
    current: s.current,
    streak: s.streak,
  }));

  const countingActive = await listCountingActiveFromDB();

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Admin</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 16px; }
    .box { border: 1px solid #ddd; padding: 12px; border-radius: 10px; margin-bottom: 12px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; }
    th { background: #f5f5f5; text-align: left; }
    input { padding: 8px; width: 360px; max-width: 100%; }
    button { padding: 8px 12px; cursor: pointer; }
    code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .small { font-size: 12px; color:#666; }
  </style>
</head>
<body>
  <h2>Admin</h2>

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
    <h3>目前 Guess 房間（記憶體）</h3>
    ${
      guessRooms.length
        ? `<table><tr><th>Channel ID</th><th>Range</th><th>Action</th></tr>
           ${guessRooms
             .map(
               (r) => `<tr>
                 <td><code>${esc(r.channelId)}</code></td>
                 <td>${r.min} ~ ${r.max}</td>
                 <td>
                   <form method="POST" action="/admin/force-stop?token=${token}" class="row">
                     <input type="hidden" name="type" value="guess"/>
                     <input type="hidden" name="channelId" value="${esc(r.channelId)}"/>
                     <button type="submit">強制停止</button>
                   </form>
                 </td>
               </tr>`
             )
             .join("")}
          </table>`
        : `<p class="small">目前沒有 Guess 房間（重啟 bot 會清空記憶體狀態）</p>`
    }
  </div>

  <div class="box">
    <h3>目前 Counting 房間（Firebase）</h3>
    ${
      countingActive.length
        ? `<table><tr><th>Guild</th><th>Channel</th><th>Next</th><th>Reward</th><th>Last</th><th>Action</th></tr>
           ${countingActive
             .map(
               (r) => `<tr>
                 <td><code>${esc(r.guildId)}</code></td>
                 <td><code>${esc(r.channelId)}</code></td>
                 <td><b>${r.next}</b> (start ${r.start})</td>
                 <td>+${r.reward}</td>
                 <td>${r.lastUserId ? `<code>${esc(r.lastUserId)}</code>` : ""}</td>
                 <td>
                   <form method="POST" action="/admin/force-stop?token=${token}" class="row">
                     <input type="hidden" name="type" value="counting"/>
                     <input type="hidden" name="guildId" value="${esc(r.guildId)}"/>
                     <input type="hidden" name="channelId" value="${esc(r.channelId)}"/>
                     <button type="submit">強制停止</button>
                   </form>
                 </td>
               </tr>`
             )
             .join("")}
          </table>`
        : `<p class="small">目前沒有 Counting 房間</p>`
    }
  </div>

  <div class="box">
    <h3>目前 HL 玩家（記憶體）</h3>
    ${
      hlPlayers.length
        ? `<table><tr><th>User</th><th>Current</th><th>Streak</th><th>Action</th></tr>
           ${hlPlayers
             .map(
               (p) => `<tr>
                 <td><code>${esc(p.userId)}</code></td>
                 <td>${p.current}</td>
                 <td>${p.streak}</td>
                 <td>
                   <form method="POST" action="/admin/force-stop?token=${token}" class="row">
                     <input type="hidden" name="type" value="hl"/>
                     <input type="hidden" name="userId" value="${esc(p.userId)}"/>
                     <button type="submit">強制停止</button>
                   </form>
                 </td>
               </tr>`
             )
             .join("")}
          </table>`
        : `<p class="small">目前沒有 HL 遊戲（重啟 bot 會清空記憶體狀態）</p>`
    }
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
    return res.redirect(`/admin?token=${encodeURIComponent(req.query.token)}&userId=${encodeURIComponent(userId)}`);
  } catch (e) {
    console.error("[AdminAdjust] Failed:", e);
    return res.status(500).send("Adjust failed");
  }
});

app.post("/admin/force-stop", async (req, res) => {
  if (!requireAdminToken(req)) return res.status(401).send("Unauthorized");

  const type = String(req.body.type || "");
  try {
    if (type === "guess") {
      const channelId = String(req.body.channelId || "");
      if (channelId) guessGame.delete(channelId);
    } else if (type === "hl") {
      const userId = String(req.body.userId || "");
      if (userId) hlGame.delete(userId);
    } else if (type === "counting") {
      const guildId = String(req.body.guildId || "");
      const channelId = String(req.body.channelId || "");
      if (guildId && channelId) {
        countingGame.delete(channelId);
        countingStoppedAt.set(channelId, Date.now());
        await stopCountingState(guildId, channelId);
      }
    }
  } catch (e) {
    console.error("[AdminForceStop] Failed:", e);
  }
  return res.redirect(`/admin?token=${encodeURIComponent(req.query.token)}`);
});

// =========================
// Discord ready
// =========================
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await registerCommandsOnce();
  await refreshLeaderboardCache();
});

// =========================
// interactionCreate
// =========================
client.on("interactionCreate", async (interaction) => {
  try {
    // ---- Slash commands ----
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === "points") {
        await interaction.deferReply({ ephemeral: true });
        const pts = await getPoints(interaction.user.id);
        return interaction.editReply(`你目前積分：**${pts}**`);
      }

      if (name === "rank") {
        const top = leaderboardCache.top;
        const ageSec = Math.floor((Date.now() - leaderboardCache.updatedAt) / 1000);
        if (!top.length) return interaction.reply("排行榜目前沒有資料～先玩遊戲拿分吧！");
        const lines = top.map((x, i) => `**#${i + 1}** <@${x.userId}> — **${x.points}**`);
        return interaction.reply(`🏆 排行榜\n${lines.join("\n")}\n\n_快取更新：${ageSec}s 前_`);
      }

      if (name === "guess") {
        await interaction.deferReply({ ephemeral: false });

        const channelId = interaction.channelId;

        // ✅ 防混：counting 正在跑就不給開 guess
        if (isCountingActive(channelId)) {
          return interaction.editReply("此頻道正在進行 Counting，請先用 `/counting stop` 停止後再開 `/guess`。");
        }

        const existing = guessGame.get(channelId);
        if (existing?.active) {
          return interaction.editReply(`此頻道已有終極密碼（${existing.min}~${existing.max}），直接輸入整數猜！`);
        }

        const min = interaction.options.getInteger("min") ?? 1;
        const max = interaction.options.getInteger("max") ?? 100;
        const realMin = Math.min(min, max);
        const realMax = Math.max(min, max);

        if (realMax - realMin < 2) {
          return interaction.editReply("範圍太小，至少要像 1~3（答案才可能在中間，不含邊界）。");
        }

        const answer = randInt(realMin + 1, realMax - 1);
        guessGame.set(channelId, { active: true, answer, min: realMin, max: realMax });

        return interaction.editReply(
          `🎯 終極密碼開始！範圍：**${realMin} ~ ${realMax}**（不含邊界）\n直接在此頻道輸入整數猜。猜中 +50 分！`
        );
      }

      if (name === "hl") {
        await interaction.deferReply({ ephemeral: false });

        const userId = interaction.user.id;
        const current = randInt(1, 13);
        hlGame.set(userId, { current, streak: 0 });

        return interaction.editReply({
          content: `🃏 高低牌開始！目前牌：**${current}**（1~13）\n猜對每回合 +5 分（會顯示總分）`,
          components: makeHLButtons(),
        });
      }

      if (name === "setup-role") {
        await interaction.deferReply({ ephemeral: true });

        if (!interaction.inGuild()) return interaction.editReply("此指令只能在伺服器使用。");

        const role = interaction.options.getRole("role");
        const label = interaction.options.getString("label") || `切換身分組：${role.name}`;

        const me = interaction.guild.members.me;
        if (!me) return interaction.editReply("讀不到我的成員資訊，請稍後再試。");

        if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          return interaction.editReply("我沒有 **Manage Roles** 權限。");
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`role:toggle:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary)
        );

        await interaction.channel.send({ content: `🔘 點按鈕切換：<@&${role.id}>`, components: [row] });
        return interaction.editReply("已送出身分組切換按鈕。");
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
          // ✅ 防混：guess 正在跑就不給開 counting
          if (isGuessActive(channelId)) {
            return interaction.editReply("此頻道正在進行 Guess，請先結束（猜中或管理員強制停止）後再開 counting。");
          }

          const start = interaction.options.getInteger("start") ?? 1;
          const reward = interaction.options.getInteger("reward") ?? 1;

          if (!Number.isInteger(start)) return interaction.editReply("start 必須是整數。");
          if (!Number.isInteger(reward) || reward <= 0) return interaction.editReply("reward 必須是正整數。");

          const state = { active: true, start, next: start, lastUserId: null, reward, guildId };
          countingGame.set(channelId, state);
          countingStoppedAt.delete(channelId);

          await saveCountingState(guildId, channelId, state);

          await interaction.channel.send(
            `🔢 Counting 已啟動！請從 **${start}** 開始。\n規則：同一人不能連續｜正確 +${reward} 分（會顯示總分）`
          );
          return interaction.editReply("已啟動 counting。");
        }

        if (sub === "stop") {
          // ✅ 完整停止：記憶體刪除 + DB active:false + stop block
          const cur = countingGame.get(channelId);
          countingGame.delete(channelId);
          countingStoppedAt.set(channelId, Date.now());

          await stopCountingState(guildId, channelId);

          await interaction.channel.send("🛑 Counting 已停止。");
          return interaction.editReply(cur?.active ? "已停止 counting。" : "已停止（或本來就沒在跑）");
        }

        if (sub === "status") {
          const s = countingGame.get(channelId) || (await loadCountingState(guildId, channelId));
          if (!s?.active) return interaction.editReply("此頻道沒有啟用 counting。");
          countingGame.set(channelId, s);
          return interaction.editReply(`✅ Counting 啟用中\n下一個：**${s.next}**｜reward：+${s.reward}`);
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
          return interaction.reply({ content: "你沒有正在進行的 /hl，請先開始。", ephemeral: true });
        }

        const action = id.split(":")[1];

        if (action === "stop") {
          hlGame.delete(userId);
          return interaction.update({ content: `🛑 已結束。連勝：**${state.streak}**`, components: [] });
        }

        const next = randInt(1, 13);
        const guessHigher = action === "higher";
        const ok = (guessHigher && next > state.current) || (!guessHigher && next < state.current);

        if (!ok) {
          hlGame.delete(userId);
          return interaction.update({
            content: `❌ 猜錯！${state.current} → ${next}\n連勝停在：**${state.streak}**`,
            components: [],
          });
        }

        await interaction.deferUpdate(); // ✅ 先回應，避免按鈕沒反應

        state.streak += 1;
        state.current = next;

        let newPts = null;
        try {
          newPts = await addPoints(userId, 5);
        } catch (e) {
          console.error("[HL] addPoints failed:", e);
        }

        return interaction.editReply({
          content:
            newPts !== null
              ? `✅ 猜對！+5 分（總分：**${newPts}**）\n目前牌：**${state.current}**｜連勝：**${state.streak}**`
              : `✅ 猜對！但加分失敗（請管理員查看 log/Firebase）\n目前牌：**${state.current}**｜連勝：**${state.streak}**`,
          components: makeHLButtons(),
        });
      }

      // Role toggle
      if (id.startsWith("role:toggle:")) {
        if (!interaction.inGuild()) return interaction.reply({ content: "只能在伺服器使用。", ephemeral: true });

        const roleId = id.split(":")[2];
        await interaction.deferReply({ ephemeral: true });

        const guild = interaction.guild;
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.editReply("讀不到你的成員資訊，請稍後再試。");

        const role = guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
        if (!role) return interaction.editReply("找不到身分組，可能已被刪除。");

        try {
          const me = guild.members.me;
          if (!me) return interaction.editReply("讀不到我的成員資訊，請稍後再試。");

          if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            return interaction.editReply("我沒有 **Manage Roles** 權限。");
          }

          if (me.roles.highest.comparePositionTo(role) <= 0) {
            return interaction.editReply(
              `我無法管理 <@&${role.id}>（我的最高身分組順序不夠高）。\n請把我的身分組移到目標身分組上方。`
            );
          }

          const has = member.roles.cache.has(role.id);
          if (has) {
            await member.roles.remove(role.id);
            return interaction.editReply(`已移除：<@&${role.id}>`);
          } else {
            await member.roles.add(role.id);
            return interaction.editReply(`已加入：<@&${role.id}>`);
          }
        } catch (e) {
          const msg = String(e?.message || e);
          const code = e?.code;
          if (code === 50013 || /Missing Permissions/i.test(msg)) {
            return interaction.editReply("權限不足（或身分組順序太低）。請把 bot 身分組移到目標身分組上方並給 Manage Roles。");
          }
          console.error("[RoleToggle] Error:", e);
          return interaction.editReply("切換失敗，請稍後再試。");
        }
      }
    }
  } catch (e) {
    console.error("[interactionCreate] Error:", e);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.editReply("發生錯誤，請稍後再試。");
        else await interaction.reply({ content: "發生錯誤，請稍後再試。", ephemeral: true });
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
    const guildId = message.guild.id;

    // ========= Guess first (only if active) =========
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

          // ✅ 一定先回訊息
          await message.reply(`🎉 猜中！答案是 **${g.answer}**\n正在加分中…`);

          try {
            const newPts = await addPoints(message.author.id, 50);
            await message.channel.send(`<@${message.author.id}> ✅ +50 分（總分：**${newPts}**）`);
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
      // guess active 時，其他數字遊戲一律不處理（避免混）
      return;
    }

    // ========= Counting (load from DB if needed) =========
    // ✅ stop 後的一段時間內，不再從 DB 自動載入，避免「已停仍回覆」
    const stoppedAt = countingStoppedAt.get(channelId);
    if (stoppedAt && Date.now() - stoppedAt < STOP_BLOCK_MS) {
      return;
    }

    let c = countingGame.get(channelId);
    if (!c) {
      const loaded = await loadCountingState(guildId, channelId);
      if (loaded) {
        countingGame.set(channelId, loaded);
        c = loaded;
      }
    }

    if (c?.active) {
      const t = message.content.trim();
      if (!/^-?\d+$/.test(t)) return;

      const n = Number(t);
      if (!Number.isInteger(n)) return;

      if (c.lastUserId && c.lastUserId === message.author.id) {
        await message.reply("⛔ 同一人不能連續兩次！請換別人接。");
        return;
      }

      if (n !== c.next) {
        c.next = c.start;
        c.lastUserId = null;
        await saveCountingState(guildId, channelId, c);
        await message.reply(`❌ 錯了！已重置，請從 **${c.start}** 重新開始。`);
        return;
      }

      // correct
      c.lastUserId = message.author.id;
      c.next += 1;
      await saveCountingState(guildId, channelId, c);

      try {
        const newPts = await addPoints(message.author.id, c.reward);
        await message.react("✅").catch(() => {});
        await message.reply(`✅ +${c.reward} 分（總分：**${newPts}**）`);
      } catch (e) {
        console.error("[Counting] addPoints failed:", e);
        await message.reply("✅ 數字正確，但加分失敗（請管理員查 log/Firebase）");
      }
      return;
    }
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

// =========================
// Graceful shutdown
// =========================
process.on("SIGINT", async () => {
  try { await client.destroy(); } catch {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  try { await client.destroy(); } catch {}
  process.exit(0);
});
