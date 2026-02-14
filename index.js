/**
 * ✅ Discord Developer Portal Intents 設定（非常重要，否則文字遊戲會失效）
 * 1) 前往：https://discord.com/developers/applications → 選你的 Bot → "Bot" 分頁
 * 2) 在 "Privileged Gateway Intents" 開啟：
 *    - ✅ MESSAGE CONTENT INTENT   （必開：讓 messageCreate 讀到玩家輸入）
 *    - ✅ SERVER MEMBERS INTENT    （建議：身分組切換更穩）
 * 3) 程式端也必須包含 GatewayIntentBits.MessageContent（本檔案已包含）
 *
 * ✅ Render 託管注意
 * - Render 需要 HTTP 服務維持運作 → 必須開 Express Server（本檔案已包含）
 *
 * ✅ Firebase 認證注意
 * - 從 process.env.FIREBASE_CONFIG 讀取「服務帳戶 JSON」字串（Render 的 ENV）
 * - private_key 裡的 \n 會自動轉回真正換行（本檔案已處理）
 *
 * ✅ 絕不逾時的互動策略
 * - 所有會碰 DB 的 slash / button：一律 deferReply() 或 deferUpdate()
 * - DB 讀寫一律 async/await
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
    GatewayIntentBits.MessageContent, // ✅ 必須：文字遊戲需要
    GatewayIntentBits.GuildMembers,   // ✅ 建議：身分組切換更穩
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
  // private_key 常見會有 \n，需要轉回真正換行
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
// In-Memory Cache (Leaderboard)
// =========================
const leaderboardCache = {
  updatedAt: 0,
  top: [], // [{ userId, points }]
};

const userPointsCache = new Map(); // userId -> points

async function refreshLeaderboardCache() {
  await dbReady;
  try {
    // 取前 10 名：orderByValue + limitToLast
    const snap = await db.ref("points").orderByValue().limitToLast(10).get();
    const val = snap.val() || {};
    const arr = Object.entries(val)
      .map(([userId, points]) => ({ userId, points: Number(points) || 0 }))
      .sort((a, b) => b.points - a.points);

    leaderboardCache.top = arr;
    leaderboardCache.updatedAt = Date.now();
  } catch (err) {
    console.error("[Cache] refreshLeaderboardCache failed:", err);
  }
}

// 每 20 秒刷新一次，確保 /rank 秒回
setInterval(() => {
  refreshLeaderboardCache().catch(() => {});
}, 20_000);

// =========================
// ✅ 核心積分系統（全域函數）
// addPoints(userId, amount)
// - 確保 DB 已連線
// - 寫入成功後才回傳
// - transaction 避免同時加分競態
// =========================
async function addPoints(userId, amount) {
  if (!userId) throw new Error("addPoints: missing userId");
  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error("addPoints: invalid amount");
  }

  await dbReady;

  const ref = db.ref(`points/${userId}`);
  const result = await ref.transaction((current) => {
    const cur = Number(current) || 0;
    return cur + delta;
  });

  if (!result.committed) {
    throw new Error("addPoints: transaction not committed");
  }

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
// Game State
// =========================

// 終極密碼：同頻道同時只能一場
const gameData = new Map(); // channelId -> { active, answer, min, max, hostId }

// 高低牌：一人一局
const hlGames = new Map(); // userId -> { current, streak }

// =========================
// Slash Commands
// =========================
const commands = [
  new SlashCommandBuilder()
    .setName("guess")
    .setDescription("啟動終極密碼遊戲（在此頻道猜數字）")
    .addIntegerOption((o) =>
      o.setName("min").setDescription("最小值").setRequired(false)
    )
    .addIntegerOption((o) =>
      o.setName("max").setDescription("最大值").setRequired(false)
    ),

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
    .addRoleOption((o) =>
      o.setName("role").setDescription("要切換的身分組").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("label")
        .setDescription("按鈕顯示文字（可選）")
        .setRequired(false)
    ),
].map((c) => c.toJSON());

// 避免每次啟動都註冊導致 rate limit：用 REGISTER_COMMANDS=true 才註冊
async function registerCommandsOnce() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    console.warn(
      "[Commands] Missing DISCORD_TOKEN or DISCORD_CLIENT_ID, skip registering."
    );
    return;
  }

  if (String(process.env.REGISTER_COMMANDS).toLowerCase() !== "true") {
    console.log("[Commands] REGISTER_COMMANDS != true, skip registering.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("[Commands] Registered global slash commands");
  } catch (err) {
    console.error("[Commands] Register failed:", err);
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
  const row = new ActionRowBuilder().addComponents(
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
  );
  return [row];
}

function safeUserTag(user) {
  if (!user) return "Unknown";
  return user.globalName ? `${user.globalName} (@${user.username})` : `@${user.username}`;
}

// =========================
// Discord Events
// =========================
client.once("ready", async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await registerCommandsOnce();
  await refreshLeaderboardCache();
});

// ---------- Slash & Button Interactions ----------
client.on("interactionCreate", async (interaction) => {
  try {
    // ===== Slash Commands =====
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // /guess
      if (commandName === "guess") {
        const channelId = interaction.channelId;

        await interaction.deferReply({ ephemeral: false });

        const existing = gameData.get(channelId);
        if (existing?.active) {
          return interaction.editReply(
            `這個頻道已經有一場終極密碼在進行中（範圍：${existing.min}~${existing.max}）。直接在頻道輸入數字猜吧！`
          );
        }

        const min = interaction.options.getInteger("min") ?? 1;
        const max = interaction.options.getInteger("max") ?? 100;

        if (!Number.isInteger(min) || !Number.isInteger(max) || min === max) {
          return interaction.editReply("min/max 需要是不同的整數喔。");
        }

        const realMin = Math.min(min, max);
        const realMax = Math.max(min, max);
        const answer = randInt(realMin, realMax);

        gameData.set(channelId, {
          active: true,
          answer,
          min: realMin,
          max: realMax,
          hostId: interaction.user.id,
        });

        return interaction.editReply(
          `🎯 終極密碼開始！範圍：**${realMin} ~ ${realMax}**\n請直接在此頻道輸入整數進行猜測。猜中者 +50 分！`
        );
      }

      // /hl
      if (commandName === "hl") {
        await interaction.deferReply({ ephemeral: false });

        const userId = interaction.user.id;
        const current = randInt(1, 13);

        hlGames.set(userId, { current, streak: 0 });

        return interaction.editReply({
          content:
            `🃏 高低牌開始！\n目前牌面：**${current}**（1~13）\n下一張會更高還是更低？猜對每回合 +5 分`,
          components: makeHLButtons(),
        });
      }

      // /rank（快取秒回）
      if (commandName === "rank") {
        const top = leaderboardCache.top;
        const ageSec = Math.floor((Date.now() - leaderboardCache.updatedAt) / 1000);

        if (!top.length) {
          return interaction.reply("排行榜目前還沒有資料～先玩遊戲拿分吧！");
        }

        const lines = top.map(
          (x, i) => `**#${i + 1}** <@${x.userId}> — **${x.points}**`
        );

        return interaction.reply(
          `🏆 排行榜（Top ${top.length}）\n${lines.join("\n")}\n\n_快取更新：${ageSec}s 前_`
        );
      }

      // /points
      if (commandName === "points") {
        await interaction.deferReply({ ephemeral: true });
        const pts = await getPoints(interaction.user.id);
        return interaction.editReply(`你目前的積分是：**${pts}**`);
      }

      // /setup-role
      if (commandName === "setup-role") {
        await interaction.deferReply({ ephemeral: true });

        if (!interaction.inGuild()) {
          return interaction.editReply("此指令只能在伺服器中使用。");
        }

        const role = interaction.options.getRole("role");
        const label =
          interaction.options.getString("label") || `切換身分組：${role.name}`;

        const me = interaction.guild.members.me;
        if (!me) return interaction.editReply("我讀不到自己的伺服器成員資訊，請稍後再試。");

        if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          return interaction.editReply("我沒有 **Manage Roles** 權限，無法幫你切換身分組。");
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`role:toggle:${role.id}`)
            .setLabel(label)
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.channel.send({
          content: `🔘 點按鈕切換身分組：<@&${role.id}>`,
          components: [row],
        });

        return interaction.editReply("已在頻道送出身分組切換按鈕。");
      }
    }

    // ===== Button Interactions =====
    if (interaction.isButton()) {
      const id = interaction.customId;

      // HL game buttons
      if (id.startsWith("hl:")) {
        const userId = interaction.user.id;
        const state = hlGames.get(userId);

        if (!state) {
          return interaction.reply({
            content: "你目前沒有正在進行的高低牌遊戲，請用 /hl 開始。",
            ephemeral: true,
          });
        }

        const action = id.split(":")[1];

        if (action === "stop") {
          hlGames.delete(userId);
          return interaction.update({
            content: `🛑 高低牌已結束。\n你的最終連勝：**${state.streak}**\n（需要再玩用 /hl）`,
            components: [],
          });
        }

        const next = randInt(1, 13);
        const guessHigher = action === "higher";
        const isCorrect =
          (guessHigher && next > state.current) ||
          (!guessHigher && next < state.current);

        if (isCorrect) {
          state.streak += 1;
          state.current = next;

          // ✅ 先 deferUpdate 保證不逾時，再等 DB 加分完成後 editReply
          await interaction.deferUpdate();
          const newPts = await addPoints(userId, 5);

          return interaction.editReply({
            content:
              `✅ 猜對！+5 分（你目前總分：**${newPts}**）\n` +
              `目前牌面：**${state.current}**（1~13）\n` +
              `連勝：**${state.streak}**\n下一張更高還是更低？`,
            components: makeHLButtons(),
          });
        } else {
          hlGames.delete(userId);
          return interaction.update({
            content:
              `❌ 猜錯！\n上一張：**${state.current}** → 下一張：**${next}**\n` +
              `你的連勝停在：**${state.streak}**\n（再玩一次用 /hl）`,
            components: [],
          });
        }
      }

      // Role toggle button
      if (id.startsWith("role:toggle:")) {
        if (!interaction.inGuild()) {
          return interaction.reply({ content: "此按鈕只能在伺服器中使用。", ephemeral: true });
        }

        const roleId = id.split(":")[2];
        await interaction.deferReply({ ephemeral: true });

        const guild = interaction.guild;
        const member = await guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.editReply("我讀不到你的成員資訊，請稍後再試。");

        const role =
          guild.roles.cache.get(roleId) ||
          (await guild.roles.fetch(roleId).catch(() => null));
        if (!role) return interaction.editReply("找不到這個身分組，可能已被刪除。");

        try {
          const hasRole = member.roles.cache.has(role.id);

          const me = guild.members.me;
          if (!me) return interaction.editReply("我讀不到自己的伺服器成員資訊，請稍後再試。");

          if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            return interaction.editReply("我沒有 **Manage Roles** 權限，無法切換身分組。");
          }

          // ✅ 身分組順序檢查（避免 50013）
          const myTop = me.roles.highest;
          if (myTop.comparePositionTo(role) <= 0) {
            return interaction.editReply(
              `我無法管理 <@&${role.id}>，因為我的最高身分組（${myTop.name}）順序不夠高。\n` +
                `請把我的身分組移到比目標身分組更高的位置。`
            );
          }

          if (hasRole) {
            await member.roles.remove(role.id);
            return interaction.editReply(`已移除身分組：<@&${role.id}>`);
          } else {
            await member.roles.add(role.id);
            return interaction.editReply(`已加入身分組：<@&${role.id}>`);
          }
        } catch (err) {
          const msg = String(err?.message || err);
          const code = err?.code;

          if (code === 50013 || /Missing Permissions/i.test(msg)) {
            return interaction.editReply(
              "我沒有足夠權限來變更你的身分組（可能是權限不足或身分組順序太低）。\n" +
                "請確認：\n" +
                "1) 我有 **Manage Roles** 權限\n" +
                "2) 我的最高身分組在目標身分組之上"
            );
          }

          console.error("[RoleToggle] Error:", err);
          return interaction.editReply("切換身分組時發生錯誤，請稍後再試。");
        }
      }
    }
  } catch (err) {
    console.error("[interactionCreate] Unhandled error:", err);
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

// ---------- Guess Game via messageCreate ----------
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const channelId = message.channel.id;
    const state = gameData.get(channelId);
    if (!state?.active) return;

    const content = message.content.trim();

    // 只接受純整數
    if (!/^-?\d+$/.test(content)) return;
    const guess = Number(content);
    if (!Number.isInteger(guess)) return;

    // 範圍外提示（不縮範圍）
    if (guess <= state.min || guess >= state.max) {
      return message.reply(`請猜 **${state.min} ~ ${state.max}** 之間的整數（不含邊界）。`);
    }

    if (guess === state.answer) {
      gameData.delete(channelId);

      const newPts = await addPoints(message.author.id, 50);

      return message.reply(
        `🎉 **猜中啦！答案是 ${state.answer}**\n` +
          `${safeUserTag(message.author)} 獲得 **+50 分**（目前總分：**${newPts}**）\n` +
          `本頻道終極密碼已結束，可用 /guess 再開一場。`
      );
    }

    // 猜錯縮範圍
    if (guess < state.answer) {
      state.min = guess;
      return message.reply(`太小了！新的範圍：**${state.min} ~ ${state.max}**`);
    } else {
      state.max = guess;
      return message.reply(`太大了！新的範圍：**${state.min} ~ ${state.max}**`);
    }
  } catch (err) {
    console.error("[messageCreate] GuessGame error:", err);
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
  console.log("SIGINT received, shutting down...");
  try {
    await client.destroy();
  } catch {}
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down...");
  try {
    await client.destroy();
  } catch {}
  process.exit(0);
});
