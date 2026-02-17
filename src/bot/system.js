"use strict";

const {
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { readState, writeState } = require("./storage");
const points = require("./points");

const CATEGORY_LOBBIES = "🎮 遊戲大廳";
const CATEGORY_ROOMS = "🎲 遊戲房間";
const CATEGORY_POINTS = "💰 積分區";
const CATEGORY_ADMIN = "🛠 管理員區";

const LOBBY_CHANNELS = {
  guess: "🟦-guess",
  hl: "🟥-hl",
  counting: "🟩-counting",
};

const CHANNEL_POINTS = "💰-積分面板";
const CHANNEL_ADMIN = "🛠-管理面板";

const ROLE_WARN = "賤人";
const ROLE_WARN_PERM = "賤人-永久";

function sysState() {
  const s = readState();
  s.system ??= {};
  s.rooms ??= {}; // userId -> { channelId, gameKey }
  s.roomActivity ??= {}; // channelId -> { lastTs, ownerId }
  s.warn ??= {}; // userId -> { until, perm }
  writeState(s);
  return s;
}

function setSystemIds(patch) {
  const s = sysState();
  s.system = { ...(s.system || {}), ...patch };
  writeState(s);
}

function getSystemIds() {
  return sysState().system || {};
}

// ---------- roles ----------
async function ensureRole(guild, name) {
  let role = guild.roles.cache.find((r) => r.name === name);
  if (role) return role;
  role = await guild.roles.create({ name });
  return role;
}

function memberIsAdmin(member) {
  return member.permissions?.has(PermissionsBitField.Flags.Administrator);
}

async function isBlocked(member) {
  if (!member) return false;
  if (memberIsAdmin(member)) return false;
  const warn = await ensureRole(member.guild, ROLE_WARN).catch(() => null);
  const perm = await ensureRole(member.guild, ROLE_WARN_PERM).catch(() => null);
  if (perm && member.roles.cache.has(perm.id)) return true;
  if (warn && member.roles.cache.has(warn.id)) return true;
  return false;
}

// ---------- channels ----------
async function ensureCategory(guild, name) {
  const exist = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  if (exist) return exist;
  return await guild.channels.create({ name, type: ChannelType.GuildCategory });
}

async function ensureTextChannel(guild, { name, parentId, overwrites, topic }) {
  const exist = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name && String(c.parentId || "") === String(parentId || "")
  );
  if (exist) {
    // patch topic if needed
    if (topic && exist.topic !== topic) await exist.setTopic(topic).catch(() => {});
    return exist;
  }
  return await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
    topic,
  });
}

async function upsertBotPanel(channel, marker, payload) {
  const msgs = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const old = msgs?.find((m) => m.author?.id === channel.client.user.id && m.content?.includes(marker));
  const content = `${marker}\n${payload.content || ""}`.trim();
  if (old) return await old.edit({ ...payload, content });
  return await channel.send({ ...payload, content });
}

// ---------- install panels ----------
function lobbyPayload(gameKey) {
  const map = { guess: "猜數字", hl: "HL", counting: "Counting" };
  const title = map[gameKey] || gameKey;

  // counting 不放 start/stop，改到管理員面板
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lobby:create:${gameKey}`).setLabel(`建立 ${title} 房間`).setStyle(ButtonStyle.Success)
  );

  if (gameKey === "counting") {
    return {
      content:
        "🟩 **Counting 大廳**\n大家直接輸入數字接龍（只允許數字，打文字會被記點）。\n⚙️ 開始/停止由管理員面板控制。",
      components: [],
    };
  }

  return {
    content: `🎮 **${title} 大廳**\n按按鈕會建立私人房間（一次只能一間）。`,
    components: [row],
  };
}

function pointsPanelPayload() {
  return {
    content: "💰 **積分面板**\n用按鈕查詢積分、排行榜、背包（商城/拍賣可後續擴充）。",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("points:me").setLabel("查詢我的積分").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("points:rank").setLabel("排行榜").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("points:bag").setLabel("我的背包").setStyle(ButtonStyle.Success)
      ),
    ],
  };
}

function adminPanelPayload() {
  return {
    content: "🛠 **管理員面板**\nCounting 控制、積分管理、房間管理、警告管理。",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin:counting:start").setLabel("🟩 Counting 開始").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("admin:counting:stop").setLabel("🟥 Counting 停止").setStyle(ButtonStyle.Danger)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("admin:points:give").setLabel("給/扣積分").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("admin:rooms:close").setLabel("關房間").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("admin:warn:clear").setLabel("解除警告").setStyle(ButtonStyle.Success)
      ),
    ],
  };
}

async function install(guild) {
  // roles
  const warnRole = await ensureRole(guild, ROLE_WARN);
  const permRole = await ensureRole(guild, ROLE_WARN_PERM);

  // categories
  const catLobby = await ensureCategory(guild, CATEGORY_LOBBIES);
  const catRooms = await ensureCategory(guild, CATEGORY_ROOMS);
  const catPoints = await ensureCategory(guild, CATEGORY_POINTS);
  const catAdmin = await ensureCategory(guild, CATEGORY_ADMIN);

  // lobby overwrites: everyone view but no send; bot send
  const lobbyOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.SendMessages],
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
  ];

  const guessLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.guess,
    parentId: catLobby.id,
    overwrites: lobbyOverwrites,
    topic: "[VIBE_SYS] lobby:guess",
  });
  const hlLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.hl,
    parentId: catLobby.id,
    overwrites: lobbyOverwrites,
    topic: "[VIBE_SYS] lobby:hl",
  });

  // counting 大廳：everyone 可發數字；但要在 games.onMessage 裡刪文字、警告
  const countingOverwrites = [
    {
      id: guild.roles.everyone.id,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
    },
    {
      id: warnRole.id,
      deny: [PermissionsBitField.Flags.ViewChannel], // 警告期間不能看/玩
    },
    {
      id: permRole.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
  ];

  const countingLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.counting,
    parentId: catLobby.id,
    overwrites: countingOverwrites,
    topic: "[VIBE_SYS] lobby:counting",
  });

  // points/admin channels: everyone no send; bot send. admin: only admin view
  const pointsOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.SendMessages],
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
  ];

  const adminOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
  ];

  // allow administrators view admin channel by granting @everyone? not possible; so we just allow users with admin permission manually by keeping channel private and using Discord admin "Administrator" permission still bypasses. In practice admins can see it even if denied.
  const pointsCh = await ensureTextChannel(guild, {
    name: CHANNEL_POINTS,
    parentId: catPoints.id,
    overwrites: pointsOverwrites,
    topic: "[VIBE_SYS] points",
  });

  const adminCh = await ensureTextChannel(guild, {
    name: CHANNEL_ADMIN,
    parentId: catAdmin.id,
    overwrites: adminOverwrites,
    topic: "[VIBE_SYS] admin",
  });

  // panels
  await upsertBotPanel(guessLobby, "[[VIBE_LOBBY:guess]]", lobbyPayload("guess"));
  await upsertBotPanel(hlLobby, "[[VIBE_LOBBY:hl]]", lobbyPayload("hl"));
  await upsertBotPanel(countingLobby, "[[VIBE_LOBBY:counting]]", lobbyPayload("counting"));
  await upsertBotPanel(pointsCh, "[[VIBE_POINTS_PANEL]]", pointsPanelPayload());
  await upsertBotPanel(adminCh, "[[VIBE_ADMIN_PANEL]]", adminPanelPayload());

  setSystemIds({
    catLobbyId: catLobby.id,
    catRoomsId: catRooms.id,
    catPointsId: catPoints.id,
    catAdminId: catAdmin.id,
    guessLobbyId: guessLobby.id,
    hlLobbyId: hlLobby.id,
    countingLobbyId: countingLobby.id,
    pointsChannelId: pointsCh.id,
    adminChannelId: adminCh.id,
    warnRoleId: warnRole.id,
    warnPermRoleId: permRole.id,
  });
}

// ---------- close system ----------
async function close(guild) {
  const ids = getSystemIds();

  // delete categories & children safely
  const toDelete = [ids.catLobbyId, ids.catRoomsId, ids.catPointsId, ids.catAdminId].filter(Boolean);

  for (const catId of toDelete) {
    const cat = guild.channels.cache.get(catId);
    if (!cat) continue;
    const children = guild.channels.cache.filter((c) => String(c.parentId) === String(catId));
    for (const ch of children.values()) {
      await ch.delete("system close").catch(() => {});
    }
    await cat.delete("system close").catch(() => {});
  }

  // delete roles
  const warnRole = guild.roles.cache.get(ids.warnRoleId) || guild.roles.cache.find((r) => r.name === ROLE_WARN);
  const permRole = guild.roles.cache.get(ids.warnPermRoleId) || guild.roles.cache.find((r) => r.name === ROLE_WARN_PERM);
  if (warnRole) await warnRole.delete("system close").catch(() => {});
  if (permRole) await permRole.delete("system close").catch(() => {});

  // wipe state
  const s = sysState();
  s.system = {};
  s.rooms = {};
  s.roomActivity = {};
  s.warn = {};
  writeState(s);
}

// ---------- AFK / activity ----------
const afkTimers = new Map(); // channelId -> timeout
const countdownTimers = new Map(); // channelId -> interval

function pingActivity(channelId) {
  const s = sysState();
  const activity = s.roomActivity[channelId];
  if (!activity) return;

  activity.lastTs = Date.now();
  s.roomActivity[channelId] = activity;
  writeState(s);

  // reset timers
  scheduleAfk(channelId, activity.ownerId);
}

async function scheduleAfk(channelId, ownerId, client) {
  if (afkTimers.has(channelId)) clearTimeout(afkTimers.get(channelId));
  if (countdownTimers.has(channelId)) {
    clearInterval(countdownTimers.get(channelId));
    countdownTimers.delete(channelId);
  }

  // 30 秒無動作 -> 開始倒數到 2 分鐘（共剩 90 秒）
  const t = setTimeout(async () => {
    const ch = client?.channels?.cache?.get(channelId);
    if (!ch) return;

    let remaining = 90;
    await ch.send(`⏳ 30 秒沒動作，${remaining} 秒後將自動關房。`).catch(() => {});

    const iv = setInterval(async () => {
      remaining -= 10;
      if (remaining <= 0) {
        clearInterval(iv);
        countdownTimers.delete(channelId);
        await forceCloseRoom(channelId, ownerId, client, "AFK 自動關房").catch(() => {});
        return;
      }
      await ch.send(`⏳ 還剩 ${remaining} 秒，自動關房倒數中…`).catch(() => {});
    }, 10_000);

    countdownTimers.set(channelId, iv);
  }, 30_000);

  afkTimers.set(channelId, t);
}

async function forceCloseRoom(channelId, ownerId, client, reason) {
  const s = sysState();
  const ch = client.channels.cache.get(channelId);
  if (ch) {
    await ch.send(`🛑 房間關閉：${reason}`).catch(() => {});
    await ch.delete(reason).catch(() => {});
  }
  delete s.roomActivity[channelId];
  if (s.rooms[ownerId]?.channelId === channelId) delete s.rooms[ownerId];
  writeState(s);

  if (afkTimers.has(channelId)) clearTimeout(afkTimers.get(channelId));
  afkTimers.delete(channelId);
  if (countdownTimers.has(channelId)) clearInterval(countdownTimers.get(channelId));
  countdownTimers.delete(channelId);
}

// 啟動時恢復（簡化：把現存 roomActivity 重新排）
async function boot(client) {
  const s = sysState();
  const entries = Object.entries(s.roomActivity || {});
  for (const [channelId, meta] of entries) {
    scheduleAfk(channelId, meta.ownerId, client);
  }

  // 清掉過期警告
  await sweepWarns(client).catch(() => {});
}

async function sweepWarns(client) {
  const s = sysState();
  const now = Date.now();

  for (const [userId, w] of Object.entries(s.warn || {})) {
    if (!w) continue;
    if (w.perm) continue;
    if (w.until && now > w.until) {
      // remove role
      const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
      if (!guild) continue;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member && s.system?.warnRoleId) {
        await member.roles.remove(s.system.warnRoleId).catch(() => {});
      }
      delete s.warn[userId];
    }
  }
  writeState(s);
}

module.exports = {
  install,
  close,
  boot,
  pingActivity,
  scheduleAfk,
  forceCloseRoom,
  sysState,
  getSystemIds,
  setSystemIds,
  ensureRole,
  isBlocked,
  ROLE_WARN,
  ROLE_WARN_PERM,
  LOBBY_CHANNELS,
  CATEGORY_ROOMS,
  CATEGORY_LOBBIES,
  CATEGORY_POINTS,
  CATEGORY_ADMIN,
};