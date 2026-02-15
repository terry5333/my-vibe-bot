/**
 * ✅ Discord Developer Portal Intents（必開）
 * Developer Portal → Applications → Bot → Privileged Gateway Intents
 *  - ✅ MESSAGE CONTENT INTENT（必開：messageCreate 才能讀玩家輸入）
 *  - ✅ SERVER MEMBERS INTENT（建議：VIP/role 功能更穩）
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
// Express
// =========================
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`[Express] Listening on :${PORT}`));

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// --- Basic Auth for /admin
function basicAuth(req, res, next) {
  const user = process.env.ADMIN_USER || "";
  const pass = process.env.ADMIN_PASS || "";
  if (!user || !pass) return res.status(500).send("Admin auth not configured (ADMIN_USER/ADMIN_PASS).");

  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");
  if (type !== "Basic" || !token) {
    res.set("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Unauthorized");
  }
  const decoded = Buffer.from(token, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const u = idx >= 0 ? decoded.slice(0, idx) : "";
  const p = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (u !== user || p !== pass) {
    res.set("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Unauthorized");
  }
  next();
}

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
// Config in Firebase (VIP / Weekly)
// =========================
const DEFAULT_CONFIG = Object.freeze({
  vip: {
    enabled: false,
    guildId: "",
    roleId: "",
    threshold: 1000,
  },
  weekly: {
    enabled: false,
    topN: 3,
    reward: 100,
    // 你想要手動重置本週發放鎖時，可以清掉 weeklyLocks/currentWeekKey
  },
});

const configCache = {
  value: { ...DEFAULT_CONFIG, vip: { ...DEFAULT_CONFIG.vip }, weekly: { ...DEFAULT_CONFIG.weekly } },
  updatedAt: 0,
};

function normalizeConfig(raw) {
  const vip = raw?.vip || {};
  const weekly = raw?.weekly || {};
  return {
    vip: {
      enabled: !!vip.enabled,
      guildId: String(vip.guildId || ""),
      roleId: String(vip.roleId || ""),
      threshold: Math.max(1, Number(vip.threshold || DEFAULT_CONFIG.vip.threshold)),
    },
    weekly: {
      enabled: !!weekly.enabled,
      topN: Math.max(1, Number(weekly.topN || DEFAULT_CONFIG.weekly.topN)),
      reward: Math.max(1, Number(weekly.reward || DEFAULT_CONFIG.weekly.reward)),
    },
  };
}

async function loadConfigOnce() {
  await dbReady;
  const snap = await db.ref("config").get();
  const cfg = normalizeConfig(snap.val() || {});
  configCache.value = cfg;
  configCache.updatedAt = Date.now();
  return cfg;
}

function getConfig() {
  return configCache.value;
}

// 監聽 config 變更，網頁改完幾秒內自動生效
(async () => {
  try {
    await dbReady;
    await loadConfigOnce();
    db.ref("config").on(
      "value",
      (snap) => {
        const cfg = normalizeConfig(snap.val() || {});
        configCache.value = cfg;
        configCache.updatedAt = Date.now();
        console.log("[Config] Updated from Firebase");
      },
      (err) => console.error("[Config] listener error:", err)
    );
  } catch (e) {
    console.error("[Config] init error:", e);
  }
})();

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

  // ✅ VIP role auto assign (依 Firebase config)
  maybeAssignVipRole(userId, newPts).catch(() => {});
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
// VIP Role Auto Assign (config in Firebase)
// =========================
async function maybeAssignVipRole(userId, points) {
  const cfg = getConfig().vip;
  if (!cfg.enabled) return;
  if (!cfg.guildId || !cfg.roleId) return;
  if (points < Number(cfg.threshold || 1)) return;

  const guildId = cfg.guildId;
  const roleId = cfg.roleId;

  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return;

  const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!me) return;

  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
  const role = guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) return;
  if (me.roles.highest.comparePositionTo(role) <= 0) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  if (member.roles.cache.has(roleId)) return;

  await member.roles.add(roleId).catch(() => {});
}

// =========================
// Game State
// =========================
const guessGame = new Map();     // channelId -> { active, answer, min, max }
const countingGame = new Map();  // channelId -> { active, start, next, lastUserId, reward, guildId }
const hlGame = new Map();        // userId -> { current, streak }

function isGuessActive(channelId) { return !!guessGame.get(channelId)?.active; }
function isCountingActive(channelId) { return !!countingGame.get(channelId)?.active; }

const COUNTING_PATH = "counting";
const countingStoppedAt = new Map();
const STOP_BLOCK_MS = 60_000;

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

function isAdminMember(interaction) {
  if (!interaction.inGuild()) return false;
  const m = interaction.member;
  return (
    m?.permissions?.has?.(PermissionsBitField.Flags.Administrator) ||
    m?.permissions?.has?.(PermissionsBitField.Flags.ManageGuild)
  );
}

// =========================
// Weekly Rewards (config in Firebase)
// =========================
function isoWeekKey(date = new Date()) {
  // ISO week key like 2026-W07
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  const y = d.getUTCFullYear();
  const w = String(weekNo).padStart(2, "0");
  return `${y}-W${w}`;
}

async function getTopN(n) {
  await dbReady;
  const snap = await db.ref("points").orderByValue().limitToLast(n).get();
  const val = snap.val() || {};
  return Object.entries(val)
    .map(([userId, points]) => ({ userId, points: Number(points) || 0 }))
    .sort((a, b) => b.points - a.points);
}

async function payoutWeeklyTop() {
  const cfg = getConfig().weekly;
  if (!cfg.enabled) return { ok: false, msg: "Weekly 未啟用（請到管理頁啟用）" };

  const topN = Math.max(1, Number(cfg.topN || 3));
  const reward = Math.max(1, Number(cfg.reward || 100));

  const top = await getTopN(topN);
  if (!top.length) return { ok: false, msg: "目前沒有任何分數資料。" };

  const weekKey = isoWeekKey(new Date());
  const lockRef = db.ref(`weeklyLocks/${weekKey}`);
  const lockSnap = await lockRef.get();
  if (lockSnap.exists()) {
    return { ok: false, msg: `本週（${weekKey}）已發放過。` };
  }

  const results = [];
  for (const r of top) {
    const newPts = await addPoints(r.userId, reward);
    results.push({ ...r, newPts });
  }

  await lockRef.set({
    weekKey,
    reward,
    topN,
    issuedAt: Date.now(),
    winners: results.map((x) => ({ userId: x.userId, before: x.points, after: x.newPts })),
  });

  return { ok: true, results, weekKey, reward, topN };
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

  new SlashCommandBuilder()
    .setName("weekly")
    .setDescription("每週排行獎勵（管理員）")
    .addSubcommand((s) => s.setName("preview").setDescription("預覽本週 Top 並顯示獎勵"))
    .addSubcommand((s) => s.setName("payout").setDescription("發放本週獎勵（只允許一次）")),
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
// Admin Dashboard (settings editable)
// =========================
async function listCountingActiveFromDB() {
  await dbReady;
  const snap = await db.ref(COUNTING_PATH).get();
  const root = snap.val() || {};
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

app.get("/admin", basicAuth, async (_req, res) => {
  await dbReady;

  const cfg = getConfig();

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
    input { padding: 8px; width: 340px; max-width: 100%; }
    button { padding: 8px 12px; cursor: pointer; }
    code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .small { font-size: 12px; color:#666; }
    label { display:inline-flex; gap:6px; align-items:center; }
  </style>
</head>
<body>
  <h2>Admin Dashboard</h2>

  <div class="box">
    <h3>VIP / Weekly 設定（存在 Firebase，改完立即生效）</h3>

    <h4>VIP 設定</h4>
    <form method="POST" action="/admin/settings" class="row">
      <input type="hidden" name="section" value="vip" />
      <label><input type="checkbox" name="enabled" ${cfg.vip.enabled ? "checked" : ""}/> 啟用</label>
      <input name="guildId" placeholder="VIP Guild ID" value="${esc(cfg.vip.guildId)}" />
      <input name="roleId" placeholder="VIP Role ID" value="${esc(cfg.vip.roleId)}" />
      <input name="threshold" placeholder="VIP Threshold" value="${esc(cfg.vip.threshold)}" />
      <button type="submit">保存 VIP</button>
    </form>
    <div class="small">注意：Bot 需要 Manage Roles，且 Bot 身分組順序要高於 VIP role。</div>

    <hr/>

    <h4>Weekly 設定</h4>
    <form method="POST" action="/admin/settings" class="row">
      <input type="hidden" name="section" value="weekly" />
      <label><input type="checkbox" name="enabled" ${cfg.weekly.enabled ? "checked" : ""}/> 啟用</label>
      <input name="topN" placeholder="Top N" value="${esc(cfg.weekly.topN)}" />
      <input name="reward" placeholder="Reward points" value="${esc(cfg.weekly.reward)}" />
      <button type="submit">保存 Weekly</button>
    </form>

    <form method="POST" action="/admin/reset-weekly-lock" class="row" style="margin-top:10px;">
      <button type="submit">重置「本週已發放」鎖（必要時才按）</button>
      <span class="small">本週 Key：<code>${esc(isoWeekKey(new Date()))}</code></span>
    </form>
  </div>

  <div class="box">
    <h3>查詢玩家 / 加扣分</h3>
    <form method="POST" action="/admin/lookup" class="row">
      <input name="userId" placeholder="Discord User ID" required />
      <button type="submit">查詢</button>
    </form>
    <br/>
    <form method="POST" action="/admin/adjust" class="row">
      <input name="userId" placeholder="Discord User ID" required />
      <input name="amount" placeholder="Amount (e.g. 50 or -10)" required />
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
                   <form method="POST" action="/admin/force-stop" class="row">
                     <input type="hidden" name="type" value="guess"/>
                     <input type="hidden" name="channelId" value="${esc(r.channelId)}"/>
                     <button type="submit">強制停止</button>
                   </form>
                 </td>
               </tr>`
             )
             .join("")}
          </table>`
        : `<p class="small">目前沒有 Guess 房間（bot 重啟會清空記憶體狀態）</p>`
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
                   <form method="POST" action="/admin/force-stop" class="row">
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
                   <form method="POST" action="/admin/force-stop" class="row">
                     <input type="hidden" name="type" value="hl"/>
                     <input type="hidden" name="userId" value="${esc(p.userId)}"/>
                     <button type="submit">強制停止</button>
                   </form>
                 </td>
               </tr>`
             )
             .join("")}
          </table>`
        : `<p class="small">目前沒有 HL 遊戲（bot 重啟會清空記憶體狀態）</p>`
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

app.post("/admin/settings", basicAuth, async (req, res) => {
  await dbReady;
  const section = String(req.body.section || "");

  try {
    if (section === "vip") {
      const enabled = !!req.body.enabled;
      const guildId = String(req.body.guildId || "").trim();
      const roleId = String(req.body.roleId || "").trim();
      const threshold = Math.max(1, Number(req.body.threshold || DEFAULT_CONFIG.vip.threshold));

      await db.ref("config/vip").set({ enabled, guildId, roleId, threshold });
    } else if (section === "weekly") {
      const enabled = !!req.body.enabled;
      const topN = Math.max(1, Number(req.body.topN || DEFAULT_CONFIG.weekly.topN));
      const reward = Math.max(1, Number(req.body.reward || DEFAULT_CONFIG.weekly.reward));

      await db.ref("config/weekly").set({ enabled, topN, reward });
    }
  } catch (e) {
    console.error("[AdminSettings] Failed:", e);
  }

  res.redirect("/admin");
});

app.post("/admin/reset-weekly-lock", basicAuth, async (_req, res) => {
  await dbReady;
  const weekKey = isoWeekKey(new Date());
  try {
    await db.ref(`weeklyLocks/${weekKey}`).remove();
  } catch (e) {
    console.error("[AdminResetWeeklyLock] Failed:", e);
  }
  res.redirect("/admin");
});

app.post("/admin/lookup", basicAuth, async (req, res) => {
  await dbReady;
  const userId = String(req.body.userId || "").trim();
  if (!userId) return res.status(400).send("Missing userId");
  const pts = await getPoints(userId);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<p>User: <code>${esc(userId)}</code></p><p>Points: <b>${pts}</b></p><p><a href="/admin">Back</a></p>`);
});

app.post("/admin/adjust", basicAuth, async (req, res) => {
  const userId = String(req.body.userId || "").trim();
  const amount = Number(req.body.amount);
  if (!userId) return res.status(400).send("Missing userId");
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).send("Invalid amount");

  try {
    await addPoints(userId, amount);
    return res.redirect("/admin");
  } catch (e) {
    console.error("[AdminAdjust] Failed:", e);
    return res.status(500).send("Adjust failed");
  }
});

app.post("/admin/force-stop", basicAuth, async (req, res) => {
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
  return res.redirect("/admin");
});

// =========================
// Discord ready
// =========================
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await registerCommandsOnce();
  await refreshLeaderboardCache();
  await loadConfigOnce().catch(() => {});
});

// =========================
// interactionCreate
// =========================
client.on("interactionCreate", async (interaction) => {
  try {
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

      if (name === "counting") {
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "此指令只能在伺服器使用。", ephemeral: true });
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;

        await interaction.deferReply({ ephemeral: true });

        if (sub === "start") {
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
            `🔢 Counting 已啟動！請從 **${start}** 開始。\n規則：同一人不能連續｜正確 +${reward} 分`
          );
          return interaction.editReply("已啟動 counting。");
        }

        if (sub === "stop") {
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

      if (name === "weekly") {
        if (!isAdminMember(interaction)) {
          return interaction.reply({ content: "只有管理員可以使用。", ephemeral: true });
        }

        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ ephemeral: false });

        if (sub === "preview") {
          const cfg = getConfig().weekly;
          if (!cfg.enabled) return interaction.editReply("Weekly 未啟用（請到管理頁啟用）");
          const top = await getTopN(Math.max(1, Number(cfg.topN || 3)));
          if (!top.length) return interaction.editReply("目前沒有任何分數資料。");
          const lines = top.map((x, i) => `**#${i + 1}** <@${x.userId}> — ${x.points}`);
          return interaction.editReply(
            `📅 本週預覽 Top ${cfg.topN}\n${lines.join("\n")}\n\n發放獎勵：每人 +${cfg.reward} 分（用 /weekly payout）`
          );
        }

        if (sub === "payout") {
          const out = await payoutWeeklyTop();
          if (!out.ok) return interaction.editReply(`❌ ${out.msg}`);
          const lines = out.results.map((x, i) => `**#${i + 1}** <@${x.userId}> ✅ +${out.reward}（新總分：${x.newPts}）`);
          return interaction.editReply(`🎉 已發放（${out.weekKey}）\n${lines.join("\n")}`);
        }
      }
    }

    // Buttons
    if (interaction.isButton()) {
      const id = interaction.customId;

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

    // Guess active → 只處理 guess（避免跟 counting 搶數字）
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
      return;
    }

    // stop-block：剛 stop 不再從 DB 載入，避免「停了還回」
    const stoppedAt = countingStoppedAt.get(channelId);
    if (stoppedAt && Date.now() - stoppedAt < STOP_BLOCK_MS) return;

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
