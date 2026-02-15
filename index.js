"use strict";

/**
 * 必開 Intents：
 * Discord Developer Portal → Applications → Bot → Privileged Gateway Intents
 * ✅ MESSAGE CONTENT INTENT（文字遊戲 messageCreate 必須）
 * ✅ SERVER MEMBERS INTENT（VIP 自動發身分組建議開）
 */

const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");

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

// =====================
// ENV
// =====================
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  FIREBASE_CONFIG,
  JWT_SECRET,
  ADMIN_USER,
  ADMIN_PASS,
  REGISTER_COMMANDS,
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !FIREBASE_CONFIG) {
  console.error("❌ 缺少必要 ENV：DISCORD_TOKEN / DISCORD_CLIENT_ID / FIREBASE_CONFIG");
  process.exit(1);
}
if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.error("❌ 缺少後台 ENV：JWT_SECRET / ADMIN_USER / ADMIN_PASS");
  process.exit(1);
}

// =====================
// 工具
// =====================
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function now() { return Date.now(); }
function randInt(min, max) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}
function isIntStr(t) { return /^-?\d+$/.test(t); }

// =====================
// Express (Railway/Render 穩定 cookie 必要設定)
// =====================
const app = express();
app.set("trust proxy", 1); // ✅ 解決登入後 cookie 不存導致 404/一直回 login
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.status(200).send("OK"));

app.use((req, _res, next) => {
  console.log("[HTTP]", req.method, req.url);
  next();
});

app.listen(PORT, () => console.log(`[Express] 已啟動：${PORT}`));

// =====================
// Firebase RTDB
// =====================
const FIREBASE_DB_URL =
  "https://my-pos-4eeee-default-rtdb.asia-southeast1.firebasedatabase.app";

function parseServiceAccount() {
  const obj = JSON.parse(FIREBASE_CONFIG);
  if (obj.private_key && typeof obj.private_key === "string") {
    obj.private_key = obj.private_key.replace(/\\n/g, "\n");
  }
  return obj;
}

admin.initializeApp({
  credential: admin.credential.cert(parseServiceAccount()),
  databaseURL: FIREBASE_DB_URL,
});
const db = admin.database();
console.log("[Firebase] 已初始化");

// =====================
// 設定（可由後台改）
// =====================
const DEFAULT_CONFIG = Object.freeze({
  vip: { enabled: false, guildId: "", roleId: "", threshold: 1000 },
  weekly: { enabled: false, topN: 3, reward: 100 },
});

const configCache = {
  value: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
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
  const snap = await db.ref("config").get();
  configCache.value = normalizeConfig(snap.val() || {});
  configCache.updatedAt = now();
}
function getConfig() { return configCache.value; }

db.ref("config").on(
  "value",
  (snap) => {
    configCache.value = normalizeConfig(snap.val() || {});
    configCache.updatedAt = now();
    console.log("[Config] 已更新");
  },
  (err) => console.error("[Config] 監聽失敗：", err)
);

// =====================
// Points + 排行榜快取（/rank 秒回）
// =====================
const pointsCache = new Map(); // userId -> points
const leaderboardCache = { updatedAt: 0, top: [] }; // [{userId, points}]

function bumpTop10(userId, points) {
  const top = leaderboardCache.top.slice();
  const idx = top.findIndex((x) => x.userId === userId);
  if (idx >= 0) top[idx] = { userId, points };
  else top.push({ userId, points });
  top.sort((a, b) => b.points - a.points);
  leaderboardCache.top = top.slice(0, 10);
  leaderboardCache.updatedAt = now();
}

async function refreshTop10() {
  try {
    const snap = await db.ref("points").orderByValue().limitToLast(10).get();
    const val = snap.val() || {};
    const arr = Object.entries(val)
      .map(([userId, points]) => ({ userId, points: Number(points) || 0 }))
      .sort((a, b) => b.points - a.points);
    leaderboardCache.top = arr;
    leaderboardCache.updatedAt = now();
  } catch (e) {
    console.error("[Cache] 更新 Top10 失敗：", e);
  }
}
setInterval(() => refreshTop10().catch(() => {}), 20_000);

// 監聽 points 變化，讓 /rank 更即時
db.ref("points").on(
  "child_changed",
  (snap) => {
    const userId = snap.key;
    const pts = Number(snap.val()) || 0;
    pointsCache.set(userId, pts);
    bumpTop10(userId, pts);
  },
  () => {}
);
db.ref("points").on(
  "child_added",
  (snap) => {
    const userId = snap.key;
    const pts = Number(snap.val()) || 0;
    pointsCache.set(userId, pts);
    bumpTop10(userId, pts);
  },
  () => {}
);

async function getPoints(userId) {
  const cached = pointsCache.get(userId);
  if (typeof cached === "number") return cached;
  const snap = await db.ref(`points/${userId}`).get();
  const pts = Number(snap.val()) || 0;
  pointsCache.set(userId, pts);
  return pts;
}

async function addPoints(userId, amount) {
  const delta = Number(amount);
  if (!userId) throw new Error("addPoints 缺少 userId");
  if (!Number.isFinite(delta) || delta === 0) throw new Error("addPoints amount 無效");

  const ref = db.ref(`points/${userId}`);
  const r = await ref.transaction((cur) => (Number(cur) || 0) + delta);
  if (!r.committed) throw new Error("addPoints 寫入未成功");

  const newPts = Number(r.snapshot.val()) || 0;
  pointsCache.set(userId, newPts);
  bumpTop10(userId, newPts);
  maybeAssignVipRole(userId, newPts).catch(() => {});
  return newPts;
}

// =====================
// Discord Client
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // ✅ 必須
    GatewayIntentBits.GuildMembers,   // ✅ VIP 建議
  ],
  partials: [Partials.Channel],
});

// =====================
// VIP 自動發身分組（後台設定）
// =====================
async function maybeAssignVipRole(userId, points) {
  const cfg = getConfig().vip;
  if (!cfg.enabled) return;
  if (!cfg.guildId || !cfg.roleId) return;
  if (points < cfg.threshold) return;

  const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
  if (!guild) return;

  const me = await guild.members.fetchMe().catch(() => null);
  if (!me) return;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;

  const role = await guild.roles.fetch(cfg.roleId).catch(() => null);
  if (!role) return;
  if (me.roles.highest.comparePositionTo(role) <= 0) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  if (member.roles.cache.has(cfg.roleId)) return;

  await member.roles.add(cfg.roleId).catch(() => {});
}

// =====================
// Weekly 結算（後台設定 + /weekly）
// =====================
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
async function getTopN(n) {
  const snap = await db.ref("points").orderByValue().limitToLast(n).get();
  const val = snap.val() || {};
  return Object.entries(val)
    .map(([userId, points]) => ({ userId, points: Number(points) || 0 }))
    .sort((a, b) => b.points - a.points);
}
async function payoutWeeklyTop() {
  const cfg = getConfig().weekly;
  if (!cfg.enabled) return { ok: false, msg: "每週結算未啟用（到後台啟用）" };

  const topN = cfg.topN;
  const reward = cfg.reward;
  const top = await getTopN(topN);
  if (!top.length) return { ok: false, msg: "目前沒有任何分數資料。" };

  const weekKey = isoWeekKey(new Date());
  const lockRef = db.ref(`weeklyLocks/${weekKey}`);
  const lockSnap = await lockRef.get();
  if (lockSnap.exists()) return { ok: false, msg: `本週（${weekKey}）已發放過。` };

  const results = [];
  for (const r of top) {
    const newPts = await addPoints(r.userId, reward);
    results.push({ ...r, newPts });
  }

  await lockRef.set({
    weekKey,
    reward,
    topN,
    issuedAt: now(),
    winners: results.map((x) => ({ userId: x.userId, before: x.points, after: x.newPts })),
  });

  return { ok: true, weekKey, reward, topN, results };
}

// =====================
// Games（全部中文 + 防打架）
// =====================

// Guess：每個頻道一場（記憶體），重啟會清
const guessGame = new Map(); // channelId -> {active, answer, min, max}

// Counting：每個頻道一場（Firebase 持久化），重啟可恢復
const COUNTING_PATH = "counting";
const countingGame = new Map(); // channelId -> {active,start,next,lastUserId,reward,guildId}
const countingStoppedAt = new Map(); // channelId -> ts（停掉後 60 秒內不回）
const STOP_BLOCK_MS = 60_000;

// HL：每個玩家一場（記憶體）
const hlGame = new Map(); // userId -> {current, streak}

function makeHLButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("hl:higher").setLabel("更大").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("hl:lower").setLabel("更小").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("hl:stop").setLabel("結束").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function loadCountingState(guildId, channelId) {
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
  await db.ref(`${COUNTING_PATH}/${guildId}/${channelId}`).set({
    active: !!state.active,
    start: state.start,
    next: state.next,
    lastUserId: state.lastUserId || null,
    reward: state.reward,
    updatedAt: now(),
  });
}
async function stopCountingState(guildId, channelId) {
  await db.ref(`${COUNTING_PATH}/${guildId}/${channelId}`).set({
    active: false,
    updatedAt: now(),
  });
}

// =====================
// Slash Commands
// =====================
const commandJSON = [
  new SlashCommandBuilder().setName("points").setDescription("查看我的積分"),
  new SlashCommandBuilder().setName("rank").setDescription("查看排行榜（秒回）"),

  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("終極密碼（此頻道猜數字）")
    .addIntegerOption((o) => o.setName("min").setDescription("最小值（預設 1）").setRequired(false))
    .addIntegerOption((o) => o.setName("max").setDescription("最大值（預設 100）").setRequired(false)),

  new SlashCommandBuilder().setName("hl").setDescription("高低牌（按鈕猜更大/更小）"),

  new SlashCommandBuilder()
    .setName("counting")
    .setDescription("數字接龍（每次正確加分）")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("在此頻道啟動接龍")
        .addIntegerOption((o) => o.setName("start").setDescription("起始數字（預設 1）").setRequired(false))
        .addIntegerOption((o) => o.setName("reward").setDescription("每次正確加幾分（預設 1）").setRequired(false))
    )
    .addSubcommand((s) => s.setName("stop").setDescription("停止此頻道接龍"))
    .addSubcommand((s) => s.setName("status").setDescription("查看此頻道接龍狀態")),

  new SlashCommandBuilder()
    .setName("setup-role")
    .setDescription("產生身分組切換按鈕（有則移除，無則加入）")
    .addRoleOption((o) => o.setName("role").setDescription("要切換的身分組").setRequired(true))
    .addStringOption((o) => o.setName("label").setDescription("按鈕文字（可選）").setRequired(false)),

  new SlashCommandBuilder()
    .setName("weekly")
    .setDescription("每週結算（管理員）")
    .addSubcommand((s) => s.setName("preview").setDescription("預覽本週 Top 與獎勵"))
    .addSubcommand((s) => s.setName("payout").setDescription("發放本週獎勵（每週一次）")),
].map((c) => c.toJSON());

async function registerCommandsOnce() {
  if (String(REGISTER_COMMANDS).toLowerCase() !== "true") {
    console.log("[Commands] REGISTER_COMMANDS != true，略過註冊");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commandJSON });
  console.log("[Commands] 已註冊全域指令");
}

function isAdminMember(interaction) {
  if (!interaction.inGuild()) return false;
  const m = interaction.member;
  return (
    m?.permissions?.has?.(PermissionsBitField.Flags.Administrator) ||
    m?.permissions?.has?.(PermissionsBitField.Flags.ManageGuild)
  );
}

// =====================
// Discord: ready
// =====================
client.once("ready", async () => {
  console.log(`[Discord] 已登入：${client.user.tag}`);
  await loadConfigOnce().catch(() => {});
  await refreshTop10().catch(() => {});
  await registerCommandsOnce().catch((e) => console.error("[Commands] 註冊失敗：", e));
});

// =====================
// Discord: interactionCreate (Slash + Buttons)
// =====================
client.on("interactionCreate", async (interaction) => {
  try {
    // ---------- Slash ----------
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === "points") {
        await interaction.deferReply({ ephemeral: true });
        const pts = await getPoints(interaction.user.id);
        return interaction.editReply(`💰 你目前積分：**${pts}**`);
      }

      if (name === "rank") {
        const top = leaderboardCache.top;
        if (!top.length) return interaction.reply("🏆 排行榜目前沒有資料～先玩遊戲拿分吧！");
        const lines = top.map((x, i) => `**#${i + 1}** <@${x.userId}> — **${x.points}**`);
        const ageSec = Math.floor((now() - leaderboardCache.updatedAt) / 1000);
        return interaction.reply(`🏆 排行榜（快取秒回）\n${lines.join("\n")}\n\n_快取更新：${ageSec}s 前_`);
      }

      if (name === "guess") {
        await interaction.deferReply({ ephemeral: false });

        const channelId = interaction.channelId;

        // 防打架：counting 開著就不讓 guess
        const c = countingGame.get(channelId);
        if (c?.active) {
          return interaction.editReply("此頻道正在進行【數字接龍】，請先用 `/counting stop` 停止後再開 `/guess`。");
        }

        const existing = guessGame.get(channelId);
        if (existing?.active) {
          return interaction.editReply(`此頻道已經有終極密碼（${existing.min} ~ ${existing.max}），直接輸入整數猜！`);
        }

        const min = interaction.options.getInteger("min") ?? 1;
        const max = interaction.options.getInteger("max") ?? 100;
        const realMin = Math.min(min, max);
        const realMax = Math.max(min, max);
        if (realMax - realMin < 3) return interaction.editReply("範圍太小，至少要像 1~4 以上。");

        // 終極密碼：答案不等於邊界
        const answer = randInt(realMin + 1, realMax - 1);
        guessGame.set(channelId, { active: true, answer, min: realMin, max: realMax });

        return interaction.editReply(
          `🎯 終極密碼開始！範圍：**${realMin} ~ ${realMax}**（不含邊界）\n直接在此頻道輸入整數猜。\n✅ 猜中 +50 分！`
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
        if (!interaction.inGuild()) return interaction.reply({ content: "此指令只能在伺服器使用。", ephemeral: true });

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;

        await interaction.deferReply({ ephemeral: true });

        if (sub === "start") {
          // 防打架：guess 開著就不讓 counting
          const g = guessGame.get(channelId);
          if (g?.active) return interaction.editReply("此頻道正在進行【終極密碼】，請先結束後再開接龍。");

          const start = interaction.options.getInteger("start") ?? 1;
          const reward = interaction.options.getInteger("reward") ?? 1;

          if (!Number.isInteger(start)) return interaction.editReply("start 必須是整數。");
          if (!Number.isInteger(reward) || reward <= 0) return interaction.editReply("reward 必須是正整數。");

          const state = { active: true, start, next: start, lastUserId: null, reward, guildId };
          countingGame.set(channelId, state);
          countingStoppedAt.delete(channelId);
          await saveCountingState(guildId, channelId, state);

          await interaction.channel.send(
            `🔢 數字接龍已啟動！請從 **${start}** 開始。\n規則：同一人不能連續｜正確 +${reward} 分（會顯示總分）`
          );
          return interaction.editReply("✅ 已啟動數字接龍。");
        }

        if (sub === "stop") {
          const cur = countingGame.get(channelId);
          countingGame.delete(channelId);
          countingStoppedAt.set(channelId, now());
          await stopCountingState(guildId, channelId);
          await interaction.channel.send("🛑 數字接龍已停止。");
          return interaction.editReply(cur?.active ? "✅ 已停止接龍。" : "✅ 已停止（或本來就沒在跑）。");
        }

        if (sub === "status") {
          const s = countingGame.get(channelId) || (await loadCountingState(guildId, channelId));
          if (!s?.active) return interaction.editReply("此頻道目前沒有啟用數字接龍。");
          countingGame.set(channelId, s);
          return interaction.editReply(`✅ 接龍啟用中\n下一個：**${s.next}**｜每次 +${s.reward} 分`);
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
        return interaction.editReply("✅ 已送出身分組切換按鈕。");
      }

      if (name === "weekly") {
        if (!isAdminMember(interaction)) {
          return interaction.reply({ content: "❌ 只有管理員可以使用。", ephemeral: true });
        }

        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ ephemeral: false });

        if (sub === "preview") {
          const cfg = getConfig().weekly;
          if (!cfg.enabled) return interaction.editReply("每週結算目前未啟用（請到管理頁啟用）。");

          const top = await getTopN(cfg.topN);
          if (!top.length) return interaction.editReply("目前沒有任何分數資料。");

          const lines = top.map((x, i) => `**#${i + 1}** <@${x.userId}> — ${x.points}`);
          return interaction.editReply(
            `📅 本週預覽 Top ${cfg.topN}\n${lines.join("\n")}\n\n🎁 發放獎勵：每人 +${cfg.reward} 分（用 /weekly payout）`
          );
        }

        if (sub === "payout") {
          const out = await payoutWeeklyTop();
          if (!out.ok) return interaction.editReply(`❌ ${out.msg}`);

          const lines = out.results.map(
            (x, i) => `**#${i + 1}** <@${x.userId}> ✅ +${out.reward}（新總分：${x.newPts}）`
          );
          return interaction.editReply(`🎉 已發放（${out.weekKey}）\n${lines.join("\n")}`);
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
        if (!state) return interaction.reply({ content: "你沒有正在進行的高低牌，請先用 /hl 開始。", ephemeral: true });

        const action = id.split(":")[1];

        if (action === "stop") {
          hlGame.delete(userId);
          return interaction.update({ content: `🛑 已結束高低牌。連勝：**${state.streak}**`, components: [] });
        }

        const next = randInt(1, 13);
        const ok = (action === "higher" && next > state.current) || (action === "lower" && next < state.current);

        if (!ok) {
          hlGame.delete(userId);
          return interaction.update({
            content: `❌ 猜錯了！${state.current} → ${next}\n連勝停在：**${state.streak}**`,
            components: [],
          });
        }

        await interaction.deferUpdate(); // 防逾時

        state.streak += 1;
        state.current = next;

        let newPts = null;
        try {
          newPts = await addPoints(userId, 5);
        } catch (e) {
          console.error("[HL] 加分失敗：", e);
        }

        return interaction.editReply({
          content:
            newPts !== null
              ? `✅ 猜對！+5 分（總分：**${newPts}**）\n目前牌：**${state.current}**｜連勝：**${state.streak}**`
              : `✅ 猜對！但加分失敗（請管理員查 Firebase/Logs）\n目前牌：**${state.current}**｜連勝：**${state.streak}**`,
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

        const role = await guild.roles.fetch(roleId).catch(() => null);
        if (!role) return interaction.editReply("找不到身分組，可能已被刪除。");

        try {
          const me = guild.members.me;
          if (!me) return interaction.editReply("讀不到我的成員資訊，請稍後再試。");
          if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            return interaction.editReply("我沒有 **Manage Roles** 權限。");
          }
          if (me.roles.highest.comparePositionTo(role) <= 0) {
            return interaction.editReply(`權限不足（身分組順序太低）。請把我的身分組移到 <@&${role.id}> 上方。`);
          }

          const has = member.roles.cache.has(role.id);
          if (has) {
            await member.roles.remove(role.id);
            return interaction.editReply(`✅ 已移除：<@&${role.id}>`);
          } else {
            await member.roles.add(role.id);
            return interaction.editReply(`✅ 已加入：<@&${role.id}>`);
          }
        } catch (e) {
          const msg = String(e?.message || e);
          const code = e?.code;
          if (code === 50013 || /Missing Permissions/i.test(msg)) {
            return interaction.editReply("權限不足（或身分組順序太低）。請調整 Bot 權限與身分組順序。");
          }
          console.error("[RoleToggle] 失敗：", e);
          return interaction.editReply("切換失敗，請稍後再試。");
        }
      }
    }
  } catch (e) {
    console.error("[interactionCreate] Error:", e);
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.editReply("❌ 發生錯誤，請稍後再試。");
        else await interaction.reply({ content: "❌ 發生錯誤，請稍後再試。", ephemeral: true });
      }
    } catch {}
  }
});

// =====================
// Discord: messageCreate（Guess + Counting）
// =====================
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const guildId = message.guild.id;
    const text = message.content.trim();

    // ----- Guess 優先（避免跟 counting 搞混）-----
    const g = guessGame.get(channelId);
    if (g?.active) {
      if (!isIntStr(text)) return;
      const n = Number(text);
      if (!Number.isInteger(n)) return;

      if (n <= g.min || n >= g.max) {
        await message.reply(`請猜 **${g.min} ~ ${g.max}** 之間（不含邊界）。`);
        return;
      }

      if (n === g.answer) {
        guessGame.delete(channelId);

        // 先回成功訊息，再加分（玩家體感更好）
        await message.reply(`🎉 猜中！答案是 **${g.answer}**\n正在加分中…`);

        try {
          const newPts = await addPoints(message.author.id, 50);
          await message.channel.send(`<@${message.author.id}> ✅ +50 分（總分：**${newPts}**）`);
        } catch (e) {
          console.error("[Guess] 加分失敗：", e);
          await message.channel.send(`<@${message.author.id}> 你應得 +50 分，但加分失敗（請管理員查 Firebase/Logs）`);
        }
        return;
      }

      if (n < g.answer) {
        g.min = n;
        await message.reply(`太小了！新範圍：**${g.min} ~ ${g.max}**`);
      } else {
        g.max = n;
        await message.reply(`太大了！新範圍：**${g.min} ~ ${g.max}**`);
      }
      return;
    }

    // ----- Counting stop-block：停了就不要再回 -----
    const stoppedAt = countingStoppedAt.get(channelId);
    if (stoppedAt && now() - stoppedAt < STOP_BLOCK_MS) return;

    // ----- Counting：必要時從 DB 恢復 -----
    let c = countingGame.get(channelId);
    if (!c) {
      const loaded = await loadCountingState(guildId, channelId);
      if (loaded) {
        countingGame.set(channelId, loaded);
        c = loaded;
      }
    }

    if (c?.active) {
      if (!isIntStr(text)) return;
      const n = Number(text);
      if (!Number.isInteger(n)) return;

      // 防連續同人
      if (c.lastUserId && c.lastUserId === message.author.id) {
        await message.reply("⛔ 同一人不能連續兩次！請換別人接。");
        return;
      }

      if (n !== c.next) {
        c.next = c.start;
        c.lastUserId = null;
        await saveCountingState(guildId, channelId, c);
        await message.reply(`❌ 接錯了！已重置，請從 **${c.start}** 重新開始。`);
        return;
      }

      c.lastUserId = message.author.id;
      c.next += 1;
      await saveCountingState(guildId, channelId, c);

      try {
        const newPts = await addPoints(message.author.id, c.reward);
        await message.react("✅").catch(() => {});
        await message.reply(`✅ 正確！+${c.reward} 分（總分：**${newPts}**）`);
      } catch (e) {
        console.error("[Counting] 加分失敗：", e);
        await message.reply("✅ 數字正確，但加分失敗（請管理員查 Firebase/Logs）");
      }
    }
  } catch (e) {
    console.error("[messageCreate] Error:", e);
  }
});

// =====================
// Admin Web: JWT auth（非彈窗）+ 玻璃擬態 UI
// =====================
function auth(req, res, next) {
  const token = req.cookies?.admin_token;
  if (!token) return res.redirect("/admin/login");
  try {
    jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.redirect("/admin/login");
  }
}
function isHttpsReq(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

app.get("/admin/login", (req, res) => {
  const showErr = req.query?.err === "1";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>管理員登入</title>
<style>
:root{
  --bg1:#0b1220; --bg2:#0f172a;
  --card: rgba(255,255,255,.08);
  --stroke: rgba(255,255,255,.14);
  --text: rgba(255,255,255,.92);
  --muted: rgba(255,255,255,.70);
  --a1:#22d3ee; --a2:#6366f1; --danger:#fb7185;
  --shadow: 0 18px 60px rgba(0,0,0,.45);
  --r: 20px;
}
*{box-sizing:border-box}
body{
  margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
  background:
    radial-gradient(1000px 700px at 20% 10%, rgba(99,102,241,.35), transparent 55%),
    radial-gradient(900px 650px at 80% 30%, rgba(34,211,238,.28), transparent 55%),
    linear-gradient(135deg,var(--bg1),var(--bg2));
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans TC", Arial;
  color:var(--text);
  padding:18px;
}
.wrap{
  width:min(980px,100%);
  display:grid;
  grid-template-columns: 1.2fr .8fr;
  gap: 18px;
}
@media (max-width: 860px){ .wrap{grid-template-columns: 1fr;} }
.hero{
  border-radius: var(--r);
  background: linear-gradient(135deg, rgba(99,102,241,.15), rgba(34,211,238,.12));
  border:1px solid var(--stroke);
  padding: 26px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(14px);
  min-height: 360px;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
}
h1{margin:0;font-size:28px;letter-spacing:.5px}
p{margin:10px 0 0 0;color:var(--muted);line-height:1.6}
.badges{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;}
.badge{
  padding:8px 12px;border-radius:999px;
  background: rgba(255,255,255,.08);
  border: 1px solid var(--stroke);
  color: rgba(255,255,255,.86);
  font-size: 12px;
}
.card{
  border-radius: var(--r);
  background: var(--card);
  border: 1px solid var(--stroke);
  padding: 22px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(14px);
  display:flex;
  flex-direction:column;
  justify-content:center;
}
label{font-size:12px;color:var(--muted);display:block;margin:10px 0 6px;}
input{
  width:100%;
  padding:12px 12px;
  border-radius: 14px;
  border:1px solid rgba(255,255,255,.16);
  background: rgba(255,255,255,.06);
  color:var(--text);
  outline:none;
}
input::placeholder{color:rgba(255,255,255,.45)}
.btn{
  width:100%;
  margin-top: 14px;
  padding: 12px 12px;
  border-radius: 14px;
  border:none;
  cursor:pointer;
  font-weight: 900;
  color: #081018;
  background: linear-gradient(135deg, var(--a1), var(--a2));
  box-shadow: 0 14px 30px rgba(34,211,238,.18);
}
.err{
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(251,113,133,.14);
  border: 1px solid rgba(251,113,133,.30);
  color: rgba(255,225,230,.95);
  font-size: 13px;
}
.small{margin-top: 10px;color:var(--muted);font-size:12px;line-height:1.5}
</style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div>
        <h1>管理員後台</h1>
        <p>管理積分、查看遊戲房間、強制停止遊戲、調整 VIP 與每週結算設定。</p>
        <div class="badges">
          <div class="badge">JWT Cookie</div>
          <div class="badge">玻璃擬態</div>
          <div class="badge">Firebase RTDB</div>
          <div class="badge">Discord.js v14</div>
        </div>
      </div>
      <p style="margin-top:18px">登入後若沒進後台，通常是 Cookie 沒存成功（此版本已修）。</p>
    </div>

    <form class="card" method="POST" action="/admin/login">
      <h2 style="margin:0 0 6px 0;">登入</h2>
      <div class="small">請輸入管理員帳號密碼。</div>

      <label>帳號</label>
      <input name="user" autocomplete="username" placeholder="例如：admin" required />

      <label>密碼</label>
      <input name="pass" type="password" autocomplete="current-password" placeholder="輸入密碼" required />

      <button class="btn" type="submit">登入後台</button>

      ${showErr ? `<div class="err">帳號或密碼錯誤</div>` : ``}
      <div class="small">登入狀態有效 12 小時。</div>
    </form>
  </div>
</body>
</html>`);
});

app.post("/admin/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = jwt.sign({ user }, JWT_SECRET, { expiresIn: "12h" });
    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: isHttpsReq(req), // ✅ 修 Railway
      sameSite: "lax",
      maxAge: 12 * 60 * 60 * 1000,
    });
    return res.redirect("/admin");
  }
  return res.redirect("/admin/login?err=1");
});

app.get("/admin/logout", (_req, res) => {
  res.clearCookie("admin_token");
  return res.redirect("/admin/login");
});

async function listCountingActiveFromDB() {
  const snap = await db.ref(COUNTING_PATH).get();
  const root = snap.val() || {};
  const rows = [];
  for (const [guildId, channels] of Object.entries(root)) {
    for (const [channelId, state] of Object.entries(channels || {})) {
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

app.get("/admin", auth, async (_req, res) => {
  const cfg = getConfig();
  const weekKey = isoWeekKey(new Date());

  const top50Snap = await db.ref("points").orderByValue().limitToLast(50).get();
  const top50Val = top50Snap.val() || {};
  const top50 = Object.entries(top50Val)
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

  const rowsTop = top50.length
    ? top50
        .map((x, i) => `<tr><td>${i + 1}</td><td><code>${esc(x.userId)}</code></td><td><b>${x.points}</b></td></tr>`)
        .join("")
    : `<tr><td colspan="3">目前沒有資料</td></tr>`;

  const rowsGuess = guessRooms.length
    ? guessRooms
        .map(
          (r) => `<tr>
<td><code>${esc(r.channelId)}</code></td>
<td>${r.min} ~ ${r.max}</td>
<td>
<form method="POST" action="/admin/force-stop" class="row">
<input type="hidden" name="type" value="guess"/>
<input type="hidden" name="channelId" value="${esc(r.channelId)}"/>
<button class="btn-danger" type="submit">強制停止</button>
</form>
</td>
</tr>`
        )
        .join("")
    : `<tr><td colspan="3">目前沒有 Guess</td></tr>`;

  const rowsCounting = countingActive.length
    ? countingActive
        .map(
          (r) => `<tr>
<td><code>${esc(r.guildId)}</code></td>
<td><code>${esc(r.channelId)}</code></td>
<td><b>${r.next}</b></td>
<td>+${r.reward}</td>
<td>
<form method="POST" action="/admin/force-stop" class="row">
<input type="hidden" name="type" value="counting"/>
<input type="hidden" name="guildId" value="${esc(r.guildId)}"/>
<input type="hidden" name="channelId" value="${esc(r.channelId)}"/>
<button class="btn-danger" type="submit">強制停止</button>
</form>
</td>
</tr>`
        )
        .join("")
    : `<tr><td colspan="5">目前沒有 Counting</td></tr>`;

  const rowsHL = hlPlayers.length
    ? hlPlayers
        .map(
          (p) => `<tr>
<td><code>${esc(p.userId)}</code></td>
<td>${p.current}</td>
<td>${p.streak}</td>
<td>
<form method="POST" action="/admin/force-stop" class="row">
<input type="hidden" name="type" value="hl"/>
<input type="hidden" name="userId" value="${esc(p.userId)}"/>
<button class="btn-danger" type="submit">強制停止</button>
</form>
</td>
</tr>`
        )
        .join("")
    : `<tr><td colspan="4">目前沒有 HL</td></tr>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>管理員後台</title>
<style>
:root{
  --bg1:#0b1220; --bg2:#0f172a;
  --card: rgba(255,255,255,.08);
  --stroke: rgba(255,255,255,.14);
  --text: rgba(255,255,255,.92);
  --muted: rgba(255,255,255,.68);
  --a1:#22d3ee; --a2:#6366f1; --danger:#fb7185;
  --shadow: 0 18px 60px rgba(0,0,0,.45);
  --r: 18px;
}
*{box-sizing:border-box}
body{
  margin:0; padding:18px;
  background:
    radial-gradient(1000px 700px at 20% 10%, rgba(99,102,241,.28), transparent 55%),
    radial-gradient(900px 650px at 80% 30%, rgba(34,211,238,.18), transparent 55%),
    linear-gradient(135deg,var(--bg1),var(--bg2));
  color:var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans TC", Arial;
}
a{color:#a5b4fc;text-decoration:none}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.title{font-size:18px;font-weight:900}
.grid{display:grid;grid-template-columns: 420px 1fr; gap: 14px;}
@media (max-width: 980px){ .grid{grid-template-columns:1fr;} }
.card{
  background:var(--card);
  border:1px solid var(--stroke);
  border-radius: var(--r);
  padding: 14px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(14px);
}
h3{margin:0 0 10px 0; font-size:13px; color: rgba(255,255,255,.86)}
.muted{color:var(--muted); font-size:12px; line-height:1.5}
.row{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
input,button{
  padding:10px 12px;
  border-radius: 14px;
  border:1px solid rgba(255,255,255,.16);
  background: rgba(255,255,255,.06);
  color: var(--text);
  outline:none;
}
input{flex:1; min-width: 140px;}
button{
  border:none; cursor:pointer; font-weight:900;
  color:#081018;
  background: linear-gradient(135deg,var(--a1),var(--a2));
}
.btn-danger{background: linear-gradient(135deg, var(--danger), #f43f5e); color:#120a0f;}
.btn-ghost{background: rgba(255,255,255,.10); color: var(--text); border:1px solid rgba(255,255,255,.14);}
table{width:100%; border-collapse:collapse; overflow:hidden; border-radius: 14px;}
th,td{padding:10px; border-bottom:1px solid rgba(255,255,255,.10); text-align:left;}
th{background: rgba(255,255,255,.06); font-size:12px; color: rgba(255,255,255,.82)}
code{background: rgba(255,255,255,.08); padding:2px 6px; border-radius: 10px;}
hr{border:none;border-top:1px solid rgba(255,255,255,.12); margin:12px 0;}
label{display:inline-flex;gap:8px;align-items:center;font-size:12px;color:rgba(255,255,255,.78)}
.small{font-size:12px;color:rgba(255,255,255,.70)}
</style>
</head>
<body>
  <div class="top">
    <div class="title">管理員後台</div>
    <div class="row">
      <div class="small">本週：<code>${esc(weekKey)}</code></div>
      <a href="/admin/logout">登出</a>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h3>積分調整</h3>
      <form class="row" method="POST" action="/admin/adjust">
        <input name="userId" placeholder="玩家 User ID" required />
        <input name="amount" placeholder="例如：50 或 -10" required />
        <button type="submit">送出</button>
      </form>
      <div class="muted" style="margin-top:10px;">輸入負數就是扣分。</div>

      <hr/>

      <h3>VIP 設定（即時生效）</h3>
      <form class="row" method="POST" action="/admin/settings">
        <input type="hidden" name="section" value="vip"/>
        <label><input type="checkbox" name="enabled" ${cfg.vip.enabled ? "checked" : ""}/> 啟用</label>
        <input name="guildId" placeholder="伺服器ID" value="${esc(cfg.vip.guildId)}"/>
        <input name="roleId" placeholder="身分組ID" value="${esc(cfg.vip.roleId)}"/>
        <input name="threshold" placeholder="門檻積分" value="${esc(cfg.vip.threshold)}"/>
        <button type="submit">保存</button>
      </form>
      <div class="muted" style="margin-top:8px;">Bot 需要 Manage Roles，且 Bot 身分組要高於 VIP 身分組。</div>

      <hr/>

      <h3>每週結算設定（即時生效）</h3>
      <form class="row" method="POST" action="/admin/settings">
        <input type="hidden" name="section" value="weekly"/>
        <label><input type="checkbox" name="enabled" ${cfg.weekly.enabled ? "checked" : ""}/> 啟用</label>
        <input name="topN" placeholder="Top N" value="${esc(cfg.weekly.topN)}"/>
        <input name="reward" placeholder="每人獎勵分數" value="${esc(cfg.weekly.reward)}"/>
        <button type="submit">保存</button>
      </form>

      <form class="row" method="POST" action="/admin/weekly/payout" style="margin-top:10px;">
        <button class="btn-ghost" type="submit">後台發放本週獎勵</button>
      </form>

      <form class="row" method="POST" action="/admin/reset-weekly-lock" style="margin-top:8px;">
        <button class="btn-ghost" type="submit">重置本週鎖（必要時）</button>
      </form>
    </div>

    <div class="card">
      <h3>Top 50 排行榜</h3>
      <table>
        <tr><th>#</th><th>玩家</th><th>積分</th></tr>
        ${rowsTop}
      </table>

      <hr/>

      <h3>正在進行的遊戲</h3>

      <div class="small">Guess（記憶體）</div>
      <table style="margin-top:8px;">
        <tr><th>頻道</th><th>範圍</th><th>操作</th></tr>
        ${rowsGuess}
      </table>

      <div style="height:12px;"></div>

      <div class="small">Counting（Firebase）</div>
      <table style="margin-top:8px;">
        <tr><th>伺服器</th><th>頻道</th><th>下一個</th><th>+分</th><th>操作</th></tr>
        ${rowsCounting}
      </table>

      <div style="height:12px;"></div>

      <div class="small">HL（記憶體）</div>
      <table style="margin-top:8px;">
        <tr><th>玩家</th><th>牌面</th><th>連勝</th><th>操作</th></tr>
        ${rowsHL}
      </table>

      <div class="muted" style="margin-top:10px;">
        Guess/HL 重啟會清空（記憶體）。Counting 會從 Firebase 恢復。
      </div>
    </div>
  </div>
</body>
</html>`);
});

app.post("/admin/settings", auth, async (req, res) => {
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
    console.error("[AdminSettings] 失敗：", e);
  }
  res.redirect("/admin");
});

app.post("/admin/adjust", auth, async (req, res) => {
  const userId = String(req.body.userId || "").trim();
  const amount = Number(req.body.amount);
  if (!userId || !Number.isFinite(amount) || amount === 0) return res.redirect("/admin");
  try {
    await addPoints(userId, amount);
  } catch (e) {
    console.error("[AdminAdjust] 失敗：", e);
  }
  res.redirect("/admin");
});

app.post("/admin/force-stop", auth, async (req, res) => {
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
        countingStoppedAt.set(channelId, now());
        await stopCountingState(guildId, channelId);
      }
    }
  } catch (e) {
    console.error("[AdminForceStop] 失敗：", e);
  }
  res.redirect("/admin");
});

app.post("/admin/weekly/payout", auth, async (_req, res) => {
  try {
    await payoutWeeklyTop();
  } catch (e) {
    console.error("[AdminWeeklyPayout] 失敗：", e);
  }
  res.redirect("/admin");
});

app.post("/admin/reset-weekly-lock", auth, async (_req, res) => {
  try {
    const weekKey = isoWeekKey(new Date());
    await db.ref(`weeklyLocks/${weekKey}`).remove();
  } catch (e) {
    console.error("[AdminResetWeeklyLock] 失敗：", e);
  }
  res.redirect("/admin");
});

// =====================
// 啟動 Discord
// =====================
client.login(DISCORD_TOKEN);
