"use strict";

/**
 * src/bot/lobbyButtons.js
 * - /install 建立大廳 + 管理員區 + 貼按鈕
 * - Lobby：建立私人房間（guess / hl）
 * - Counting：🟩-counting 大廳聊天接龍；控制按鈕放在「管理員區」面板
 * - 防多進程重複創房：Firestore room lock（roomState）
 * - AFK 自動關房（可調）
 * - Button 互動：安全 ACK（避免 40060 / 10062）
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

const gamesMod = require("./games");
const roomState = require("../db/roomState");
const countingDb = require("../db/countingState");

// ====== 設定 ======
const CATEGORY_LOBBIES = "🎮 遊戲大廳";
const CATEGORY_ROOMS = "🎲 遊戲房間";
const CATEGORY_ADMIN = "🛡 管理員區";

const LOBBY_CHANNELS = {
  guess: "🟦-guess",
  hl: "🟥-hl",
  counting: "🟩-counting",
};

const ADMIN_CHANNELS = {
  panel: "🛠-admin-panel",
};

const GAME_ZH = {
  guess: "猜數字",
  hl: "HL",
  counting: "Counting",
};

// 房間 AFK 幾分鐘自動關（可調）
const AFK_MS = 10 * 60 * 1000;
const AFK_SCAN_MS = 30 * 1000;

// userId -> { channelId, gameKey, guildId }
const userRoomMap = new Map();

// channelId -> { ownerId, guildId, lastActiveAt }
const roomActivity = new Map();

let afkTimerStarted = false;

// ====== helpers ======
function sanitizeName(name) {
  return (
    String(name || "player")
      .replace(/[^\p{L}\p{N}\- _]/gu, "")
      .trim()
      .slice(0, 20) || "player"
  );
}

function isAdminMember(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

async function ensureCategory(guild, name) {
  const exist = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name
  );
  if (exist) return exist;

  return await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
  });
}

async function ensureTextChannel(guild, { name, parentId, overwrites }) {
  const exist = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.name === name &&
      String(c.parentId || "") === String(parentId || "")
  );
  if (exist) return exist;

  return await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
  });
}

async function upsertMarkerMessage(channel, marker, payload) {
  const msgs = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const old = msgs?.find(
    (m) => m.author?.id === channel.client.user.id && m.content?.includes(marker)
  );

  if (old) return await old.edit(payload);
  return await channel.send({ ...payload, content: `${marker}\n${payload.content}` });
}

function buildLobbyPayload(gameKey) {
  // counting lobby 不放控制按鈕（放 admin 區）
  if (gameKey === "counting") {
    return {
      content:
        "🟩 **Counting 大廳**\n" +
        "🔢 管理員在「🛠-admin-panel」按下「開始」後，大家才能在這裡輸入數字接龍。\n" +
        "⛔ 未開始/暫停/停止時，任何訊息都會被刪除並私訊提醒。",
      components: [],
    };
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lobby:create:${gameKey}`)
      .setLabel(`建立 ${GAME_ZH[gameKey]} 房間`)
      .setStyle(ButtonStyle.Success)
  );

  return {
    content: `🎮 **${GAME_ZH[gameKey]} 大廳**\n按按鈕會自動建立私人房間（一次只能一間）。`,
    components: [row],
  };
}

function buildAdminPanelPayload(guildId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin:counting:start:${guildId}`)
      .setLabel("🟩 開始 Counting")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`admin:counting:pause:${guildId}`)
      .setLabel("⏸ 暫停 Counting")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`admin:counting:stop:${guildId}`)
      .setLabel("🛑 停止 Counting")
      .setStyle(ButtonStyle.Danger)
  );

  return {
    content: "🛠️ **管理員面板**\n在這裡控制 Counting 狀態（開始/暫停/停止）。\n（只有管理員能按）",
    components: [row1],
  };
}

function getCountingLobbyChannel(guild) {
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === LOBBY_CHANNELS.counting
  );
}

async function ensureAfkTimer(client) {
  if (afkTimerStarted) return;
  afkTimerStarted = true;

  setInterval(async () => {
    try {
      const now = Date.now();

      for (const [channelId, info] of roomActivity.entries()) {
        if (!info?.lastActiveAt) continue;
        if (now - info.lastActiveAt < AFK_MS) continue;

        const guild = client.guilds.cache.get(info.guildId);
        const ch = guild?.channels?.cache?.get(channelId);
        if (!guild || !ch) {
          roomActivity.delete(channelId);
          continue;
        }

        userRoomMap.delete(info.ownerId);
        roomActivity.delete(channelId);

        await roomState.clearRoom({ guildId: info.guildId, userId: info.ownerId }).catch(() => {});
        gamesMod.games.guessStop(channelId);
        gamesMod.games.hlStop(channelId);

        await ch.send("⌛ 房間太久沒人動作（AFK），已自動關閉。").catch(() => {});
        await ch.delete("AFK auto close").catch(() => {});
      }
    } catch (_) {}
  }, AFK_SCAN_MS);
}

// ====== 安全互動 ACK（避免 40060 / 10062）======
function isAckError(err) {
  const code = err?.code;
  return code === 40060 || code === 10062;
}

async function safeDeferReply(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    return true;
  } catch (err) {
    if (isAckError(err)) return false;
    throw err;
  }
}

async function safeEditOrReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.reply(payload);
  } catch (err) {
    if (isAckError(err)) return null;
    throw err;
  }
}

// ====== public: ping activity (index.js 會呼叫) ======
function pingActivity(channelId, userId) {
  const room = roomActivity.get(channelId);
  if (!room) return;
  if (room.ownerId !== userId) return;
  room.lastActiveAt = Date.now();
}

// ====== /install 用：建立/更新頻道與按鈕 ======
async function ensureLobbyChannelsAndButtons(guild) {
  const catLobby = await ensureCategory(guild, CATEGORY_LOBBIES);
  const catAdmin = await ensureCategory(guild, CATEGORY_ADMIN);

  // 大廳：大家可看、不可講；機器人可講
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

  // 🟩-counting：大家要能打字（但是否有效由 games.js/countingState 控制）
  const countingOverwrites = [
    {
      id: guild.roles.everyone.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.SendMessages,
      ],
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

  // 管理員區：@everyone 看不到；機器人可看可講
  const adminOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
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
  });

  const hlLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.hl,
    parentId: catLobby.id,
    overwrites: lobbyOverwrites,
  });

  const countingLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.counting,
    parentId: catLobby.id,
    overwrites: countingOverwrites,
  });

  const adminPanel = await ensureTextChannel(guild, {
    name: ADMIN_CHANNELS.panel,
    parentId: catAdmin.id,
    overwrites: adminOverwrites,
  });

  await upsertMarkerMessage(guessLobby, `[[VIBE_LOBBY:guess]]`, buildLobbyPayload("guess"));
  await upsertMarkerMessage(hlLobby, `[[VIBE_LOBBY:hl]]`, buildLobbyPayload("hl"));
  await upsertMarkerMessage(
    countingLobby,
    `[[VIBE_LOBBY:counting]]`,
    buildLobbyPayload("counting")
  );

  await upsertMarkerMessage(adminPanel, `[[VIBE_ADMIN:PANEL]]`, buildAdminPanelPayload(guild.id));

  return { guessLobby, hlLobby, countingLobby, adminPanel };
}

// ====== create room ======
async function createGameRoom(interaction, gameKey) {
  const guild = interaction.guild;
  const catRooms = await ensureCategory(guild, CATEGORY_ROOMS);

  const creatorName = sanitizeName(interaction.member?.displayName || interaction.user.username);
  const channelName = `${GAME_ZH[gameKey]}-${creatorName}`.replace(/\s+/g, "-").slice(0, 90);

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.ManageMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
  ];

  const room = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: catRooms.id,
    permissionOverwrites: overwrites,
  });

  userRoomMap.set(interaction.user.id, { channelId: room.id, gameKey, guildId: guild.id });
  roomActivity.set(room.id, {
    ownerId: interaction.user.id,
    guildId: guild.id,
    lastActiveAt: Date.now(),
  });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`room:close:${interaction.user.id}:${guild.id}`)
      .setLabel("🗑 關閉房間")
      .setStyle(ButtonStyle.Danger)
  );

  await room.send({
    content: `✅ 房間建立完成：<@${interaction.user.id}>\n遊戲：**${GAME_ZH[gameKey]}**`,
    components: [closeRow],
  });

  // 啟動遊戲
  if (gameKey === "hl") {
    const fake = { user: interaction.user, channel: room };
    await gamesMod.games.hlStart(fake, room.id, 13);
  }

  if (gameKey === "guess") {
    gamesMod.games.guessStart(room.id, { min: 1, max: 100 });
    await room.send("🟦 **Guess 已開始！** 範圍：**1 ~ 100**（直接在聊天室打數字猜）");
  }

  return room;
}

// ====== handle interactions ======
async function handleInteraction(interaction, ctx = {}) {
  const client = ctx.client || interaction.client;
  await ensureAfkTimer(client);

  if (!(interaction.isButton() || interaction.isModalSubmit() || interaction.isAnySelectMenu())) {
    return false;
  }

  if (!interaction.isButton()) return false;

  const id = interaction.customId;

  // ===== 建房（guess/hl）=====
  if (id.startsWith("lobby:create:")) {
    const gameKey = id.split(":")[2];

    if (!["guess", "hl"].includes(gameKey)) {
      await safeEditOrReply(interaction, {
        content: "❌ 這個遊戲不支援建房。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // ✅ 先 ACK：避免 3 秒超時 / unknown interaction
    const okAck = await safeDeferReply(interaction);
    if (!okAck) return true; // 其他進程已 ack

    // ✅ Firestore 原子鎖：多進程也只會成功一次
    const lock = await roomState.tryLockRoom({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      gameKey,
    });

    if (!lock.ok) {
      if (lock.reason === "active_exists" && lock.channelId) {
        await safeEditOrReply(interaction, {
          content: `⚠️ 你已經有房間：<#${lock.channelId}>`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      await safeEditOrReply(interaction, {
        content: "⏳ 正在建立房間中，請稍後再試一次。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // 同一進程內再擋一次（非主要保險）
    const existing = userRoomMap.get(interaction.user.id);
    if (existing?.channelId) {
      await safeEditOrReply(interaction, {
        content: `⚠️ 你目前已有一間房：<#${existing.channelId}>`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const room = await createGameRoom(interaction, gameKey);

    await roomState.setRoomActive({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      gameKey,
      channelId: room.id,
    });

    await safeEditOrReply(interaction, {
      content: `✅ 已建立你的房間：<#${room.id}>`,
      flags: MessageFlags.Ephemeral,
    });

    return true;
  }

  // ===== 房間關閉 =====
  if (id.startsWith("room:close:")) {
    const [, , ownerId, guildId] = id.split(":");

    const okAck = await safeDeferReply(interaction);
    if (!okAck) return true;

    if (interaction.user.id !== ownerId) {
      await safeEditOrReply(interaction, { content: "❌ 只有房主能關房。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const ch = interaction.channel;

    userRoomMap.delete(ownerId);
    roomActivity.delete(ch.id);

    await roomState.clearRoom({ guildId, userId: ownerId }).catch(() => {});
    gamesMod.games.guessStop(ch.id);
    gamesMod.games.hlStop(ch.id);

    await safeEditOrReply(interaction, { content: "🗑 正在關閉房間…", flags: MessageFlags.Ephemeral });
    await ch.delete("room closed").catch(() => {});
    return true;
  }

  // ===== 管理員：Counting 控制面板 =====
  if (id.startsWith("admin:counting:")) {
    const okAck = await safeDeferReply(interaction);
    if (!okAck) return true;

    if (!isAdminMember(interaction)) {
      await safeEditOrReply(interaction, { content: "❌ 只有管理員能操作。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const [, , action, guildId] = id.split(":");
    if (guildId !== interaction.guildId) {
      await safeEditOrReply(interaction, { content: "❌ guild 不匹配。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const countingLobby = getCountingLobbyChannel(interaction.guild);
    if (!countingLobby) {
      await safeEditOrReply(interaction, {
        content: "❌ 找不到 🟩-counting 頻道，請先 /install。",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (action === "start") {
      await countingDb.setCounting(interaction.guildId, countingLobby.id, {
        state: "playing",
        expected: 1,
        lastUserId: null,
      });
      await countingLobby.send("🟩 **Counting 已開始！** 🔢 請輸入 **1** 開始接龍。");
      await safeEditOrReply(interaction, { content: "✅ 已開始 Counting", flags: MessageFlags.Ephemeral });
      return true;
    }

    if (action === "pause") {
      await countingDb.setCounting(interaction.guildId, countingLobby.id, { state: "paused" });
      await countingLobby.send("⏸ **Counting 已暫停。**（暫停期間任何訊息都會被刪除並私訊提醒）");
      await safeEditOrReply(interaction, { content: "✅ 已暫停 Counting", flags: MessageFlags.Ephemeral });
      return true;
    }

    if (action === "stop") {
      await countingDb.setCounting(interaction.guildId, countingLobby.id, {
        state: "stopped",
        expected: 1,
        lastUserId: null,
      });
      await countingLobby.send("🛑 **Counting 已停止。**（停止期間任何訊息都會被刪除並私訊提醒）");
      await safeEditOrReply(interaction, { content: "✅ 已停止 Counting", flags: MessageFlags.Ephemeral });
      return true;
    }

    await safeEditOrReply(interaction, { content: "❌ 未知操作", flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}

module.exports = {
  ensureLobbyChannelsAndButtons,
  handleInteraction,
  pingActivity,
};