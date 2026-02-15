/**
 * ✅ Discord Developer Portal Intents（必開，否則文字遊戲會失效）
 * Developer Portal → Applications → Bot → Privileged Gateway Intents：
 *  - ✅ MESSAGE CONTENT INTENT（必開：messageCreate 才能讀玩家輸入）
 *  - ✅ SERVER MEMBERS INTENT（建議：/setup-role 切身分組更穩）
 *
 * ✅ ENV（Railway/Render 都一樣）
 * DISCORD_TOKEN=...
 * DISCORD_CLIENT_ID=...（Application ID）
 * FIREBASE_CONFIG=一行JSON（service account）
 * ADMIN_TOKEN=你自訂長亂碼（管理頁面用）
 * REGISTER_COMMANDS=true（要更新指令才開，成功後改 false）
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
// Express keep-alive + Admin page
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
    GatewayIntentBits.MessageContent, // ✅ 必須：讀玩家輸入
    GatewayIntentBits.GuildMembers, // ✅ 建議：身分組功能更穩
  ],
  partials: [Partials.Channel],
});

// =========================
// Firebase Init (Realtime Database)
// =========================
// ✅ 依你 log 的 region 建議，改成 asia-southeast1 的 URL（更穩更快）
const FIREBASE_DB_URL =
  "https://my-pos-4eeee-default-rtdb.asia-southeast1.firebasedatabase.app/";

function parseFirebaseConfig() {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) throw new Error("Missing process.env.FIREBASE_CONFIG");
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_CONFIG is not valid JSON (must be ONE LINE)");
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
// In-memory Cache: leaderboard must be fast (/rank 秒回)
// =========================
const leaderboardCache = {
  updatedAt: 0,
  top: [], // [{userId, points}]
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
    console.error("[Cache] refresh failed:", e);
  }
}
setInterval(() => refreshLeaderboardCache().catch(() => {}), 20_000);

// =========================
// ✅ Points Core (global function)
// =========================
async function addPoints(userId, amount) {
  if (!userId) throw new Error("addPoints: missing userId");
  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta === 0)
    throw new Error("addPoints: invalid amount");

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
// Admin Web Page
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
            `<tr><td>${i + 1}</td><td><code>${esc(
              x.userId
            )}</code></td><td><b>${x.points}</b></td></tr>`
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
  if (!Number.isFinite(amount) || amount === 0)
    return res.status(400).send("Invalid amount");

  try {
    await addPoints(userId, amount);
    return res.redirect(
      `/admin?token=${encodeURIComponent(
        req.query.token
      )}&userId=${encodeURIComponent(userId)}`
    );
  } catch (e) {
    console.error("[AdminAdjust] Failed:", e);
    return res.status(500).send("Adjust failed");
  }
});

// =========================
// Game State
// =========================

// Guess game (per-channel)
const guessGame = new Map(); // channelId -> {active, answer, min, max}

// HL game (per-user)
const hlGame = new Map(); // userId -> { current, streak }

// Counting game (per-channel) + persistence
const countingGame = new Map(); // channelId -> { active, start, next, lastUserId, reward }
const COUNTING_PATH = "counting"; // counting/{guildId}/{channelId}

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
      new ButtonBuilder()
        .setCustomId("hl:higher")
        .setLabel("Higher")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("hl:lower")
        .setLabel("Lower")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("hl:stop")
        .setLabel("Stop")
        .setStyle(ButtonStyle.Secondary)
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
// Slash Commands (Register)
// =========================
const commandJSON = [
  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("啟動終極密碼（此頻道猜數字）")
    .addIntegerOption((o) =>
      o.setName("min").setDescription("最小值").setRequired(false)
    )
    .addIntegerOption((o) =>
      o.setName("max").setDescription("最大值").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("hl")
    .setDescription("高低牌（按鈕猜 higher / lower）"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("查看排行榜（快取秒回）"),

  new SlashCommandBuilder().setName("points").setDescription("查看你的積分"),

  new SlashCommandBuilder()
    .setName("setup-role")
    .setDescription("產生身分組切換按鈕（有則移除，無則加入）")
    .addRoleOption((o) =>
      o.setName("role").setDescription("要切換的身分組").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("label")
        .setDescription("按鈕文字（可選）")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("counting")
    .setDescription("Counting 遊戲")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("在此頻道啟動 counting")
        .addIntegerOption((o) =>
          o
            .setName("start")
            .setDescription("起始數字（預設 1）")
            .setRequired(false)
        )
        .addIntegerOption((o) =>
          o
            .setName("reward")
            .setDescription("每次正確加分（預設 1）")
            .setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s.setName("stop").setDescription("停止此頻道 counting")
    )
    .addSubcommand((s) =>
      s.setName("status").setDescription("查看此頻道 counting 狀態")
    ),
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
// Discord Events
// =========================
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await registerCommandsOnce();
  await refreshLeaderboardCache();
});

// =========================
// interactionCreate (slash + buttons)
// =========================
client.on("interactionCreate", async (interaction) => {
  try {
    // ---------- Slash commands ----------
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      // /points
      if (name === "points") {
        await interaction.deferReply({ ephemeral: true });
        const pts = await getPoints(interaction.user.id);
        return interaction.editReply(`你目前積分：**${pts}**`);
      }

      // /rank (cache fast)
      if (name === "rank") {
        const top = leaderboardCache.top;
        const ageSec = Math.floor(
          (Date.now() - leaderboardCache.updatedAt) / 1000
        );
        if (!top.length) {
          return interaction.reply("排行榜目前沒有資料～先玩遊戲拿分吧！");
        }
        const lines = top.map(
          (x, i) => `**#${i + 1}** <@${x.userId}> — **${x.points}**`
        );
        return interaction.reply(
          `🏆 排行榜\n${lines.join("\n")}\n\n_快取更新：${ageSec}s 前_`
        );
      }

      // /guess
      if (name === "guess") {
        await interaction.deferReply({ ephemeral: false });

        const channelId = interaction.channelId;
        const existing = guessGame.get(channelId);
        if (existing?.active) {
          return interaction.editReply(
            `此頻道已有終極密碼（${existing.min}~${existing.max}），直接在頻道輸入整數猜！`
          );
        }

        const min = interaction.options.getInteger("min") ?? 1;
        const max = interaction.options.getInteger("max") ?? 100;
        const realMin = Math.min(min, max);
        const realMax = Math.max(min, max);

        if (realMax - realMin < 2) {
          return interaction.editReply(
            "範圍太小，至少要像 1~3（答案才可能在中間，不含邊界）。"
          );
        }

        const answer = randInt(realMin + 1, realMax - 1); // ✅ 不落在邊界

        guessGame.set(channelId, {
          active: true,
          answer,
          min: realMin,
          max: realMax,
        });

        return interaction.editReply(
          `🎯 終極密碼開始！範圍：**${realMin} ~ ${realMax}**（不含邊界）\n直接在此頻道輸入整數猜。猜中 +50 分！`
        );
      }

      // /hl
      if (name === "hl") {
        await interaction.deferReply({ ephemeral: false });

        const userId = interaction.user.id;
        const current = randInt(1, 13);
        hlGame.set(userId, { current, streak: 0 });

        return interaction.editReply({
          content: `🃏 高低牌開始！目前牌：**${current}**（1~13）\n猜對每回合 +5 分`,
          components: makeHLButtons(),
        });
      }

      // /setup-role
      if (name === "setup-role") {
        await interaction.deferReply({ ephemeral: true });

        if (!interaction.inGuild()) {
          return interaction.editReply("此指令只能在伺服器中使用。");
        }

        const role = interaction.options.getRole("role");
        const label =
          interaction.options.getString("label") || `切換身分組：${role.name}`;

        const me = interaction.guild.members.me;
        if (!me) return interaction.editReply("讀不到我的成員資訊，請稍後再試。");

        if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          return interaction.editReply("我沒有 **Manage Roles** 權限。");
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`role:toggle:${role.id}`)
            .setLabel(label)
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.channel.send({
          content: `🔘 點按鈕切換：<@&${role.id}>`,
          components: [row],
        });

        return interaction.editReply("已送出身分組切換按鈕。");
      }

      // /counting
      if (name === "counting") {
        if (!interaction.inGuild()) {
          return interaction.reply({
            content: "此指令只能在伺服器中使用。",
            ephemeral: true,
          });
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;

        await interaction.deferReply({ ephemeral: true });

        if (sub === "start") {
          const start = interaction.options.getInteger("start") ?? 1;
          const reward = interaction.options.getInteger("reward") ?? 1;

          if (!Number.isInteger(start))
            return interaction.editReply("start 必須是整數。");
          if (!Number.isInteger(reward) || reward <= 0)
            return interaction.editReply("reward 必須是正整數。");

          const state = {
            active: true,
            start,
            next: start,
            lastUserId: null,
            reward,
          };

          countingGame.set(channelId, state);
          await saveCountingState(guildId, channelId, state);

          await interaction.channel.send(
            `🔢 Counting 已啟動！請從 **${start}** 開始依序輸入。\n規則：同一人不能連續兩次｜正確 +${reward} 分`
          );

          return interaction.editReply("已啟動 counting。");
        }

        if (sub === "stop") {
          countingGame.delete(channelId);
          await stopCountingState(guildId, channelId);
          await interaction.channel.send("🛑 Counting 已停止。");
          return interaction.editReply("已停止 counting。");
        }

        if (sub === "status") {
          const mem =
            countingGame.get(channelId) ||
            (await loadCountingState(guildId, channelId));

          if (!mem?.active) {
            return interaction.editReply("此頻道目前沒有啟用 counting。");
          }

          countingGame.set(channelId, mem);

          return interaction.editReply(
            `✅ Counting 啟用中\n下一個：**${mem.next}**｜起始：${mem.start}｜reward：+${mem.reward}\n上一位：${
              mem.lastUserId ? `<@${mem.lastUserId}>` : "無"
            }`
          );
        }
      }
    }

    // ---------- Buttons ----------
    if (interaction.isButton()) {
      const id = interaction.customId;

      // HL
      if (id.startsWith("hl:")) {
        const userId = interaction.user.id;
        const state = hlGame.get(userId);

        if (!state) {
          return interaction.reply({
            content: "你目前沒有正在進行的高低牌，請用 /hl 開始。",
            ephemeral: true,
          });
        }

        const action = id.split(":")[1];

        if (action === "stop") {
          hlGame.delete(userId);
          return interaction.update({
            content: `🛑 已結束高低牌。連勝：**${state.streak}**`,
            components: [],
          });
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

        // ✅ 避免按鈕逾時：先 deferUpdate
        await interaction.deferUpdate();

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
              : `✅ 猜對！但加分失敗（請管理員查 log/Firebase）\n目前牌：**${state.current}**｜連勝：**${state.streak}**`,
          components: makeHLButtons(),
        });
      }

      // Role toggle
      if (id.startsWith("role:toggle:")) {
        if (!interaction.inGuild()) {
          return interaction.reply({
            content: "此按鈕只能在伺服器中使用。",
            ephemeral: true,
          });
        }

        const roleId = id.split(":")[2];
        await interaction.deferReply({ ephemeral: true });

        const guild = interaction.guild;
        const member = await guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
        if (!member) return interaction.editReply("讀不到你的成員資訊，請稍後再試。");

        const role =
          guild.roles.cache.get(roleId) ||
          (await guild.roles.fetch(roleId).catch(() => null));
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
            return interaction.editReply(
              "權限不足或身分組順序太低。\n請確認我有 Manage Roles，且我的身分組在目標身分組之上。"
            );
          }
          console.error("[RoleToggle] Error:", e);
          return interaction.editReply("切換失敗，請稍後再試。");
        }
      }
    }
  } catch (e) {
    console.error("[interactionCreate] Unhandled:", e);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("發生錯誤，請稍後再試。");
        } else {
          await interaction.reply({
            content: "發生錯誤，請稍後再試。",
            ephemeral: true,
          });
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
    const guildId = message.guild.id;

    // -------- Guess game --------
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

          // ✅ 先公告一定跳訊息
          await message.reply(`🎉 猜中！答案是 **${g.answer}**\n正在加分中…`);

          try {
            const newPts = await addPoints(message.author.id, 50);
            await message.channel.send(
              `<@${message.author.id}> ✅ +50 分（總分：**${newPts}**）`
            );
          } catch (e) {
            console.error("[Guess] addPoints failed:", e);
            await message.channel.send(
              `<@${message.author.id}> 你應得 +50 分，但加分失敗（請管理員查 log/Firebase）`
            );
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

    // -------- Counting game --------
    // 記憶體沒有就從 Firebase 撈（防止重啟丟狀態）
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
        await message.reply("⛔ 同一個人不能連續兩次！請換別人接。");
        return;
      }

      if (n !== c.next) {
        c.next = c.start;
        c.lastUserId = null;
        await saveCountingState(guildId, channelId, c);
        await message.reply(`❌ 錯了！已重置，請從 **${c.start}** 重新開始。`);
        return;
      }

      // 正確
      c.lastUserId = message.author.id;
      c.next += 1;
      await saveCountingState(guildId, channelId, c);

      try {
        await addPoints(message.author.id, c.reward);
      } catch (e) {
        console.error("[Counting] addPoints failed:", e);
        await message.reply("✅ 數字正確，但加分失敗（請管理員查 log/Firebase）");
        return;
      }

      // 反應（需要 Add Reactions 權限）
      await message.react("✅").catch(() => {});
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
  try {
    await client.destroy();
  } catch {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  try {
    await client.destroy();
  } catch {}
  process.exit(0);
});
