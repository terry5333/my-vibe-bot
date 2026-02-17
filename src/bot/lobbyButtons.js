"use strict";

/**
 * src/bot/lobbyButtons.js
 * ✅ 大廳按鈕
 * ✅ 建私人房間（一次只能一間）
 * ✅ 回覆用 ephemeral（別人看不到你創房）
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

const CATEGORY_LOBBIES = "🎮 遊戲大廳";
const CATEGORY_ROOMS = "🎲 遊戲房間";

const LOBBY_CHANNELS = {
  guess: "🟦-guess",
  hl: "🟥-hl",
  counting: "🟩-counting",
};

const GAME_ZH = {
  guess: "猜數字",
  hl: "HL",
  counting: "Counting",
};

const userRoomMap = new Map(); // userId -> { channelId, gameKey }
const roomOwnerMap = new Map(); // channelId -> userId

// for future AFK feature
const lastActivityMap = new Map(); // channelId -> { userId, ts }
function pingActivity(channelId, userId) {
  lastActivityMap.set(channelId, { userId, ts: Date.now() });
}

function sanitizeName(name) {
  return String(name || "player")
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .trim()
    .slice(0, 20) || "player";
}

async function ensureCategory(guild, name) {
  const exist = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  if (exist) return exist;

  return await guild.channels.create({ name, type: ChannelType.GuildCategory });
}

async function ensureTextChannel(guild, { name, parentId, overwrites }) {
  const exist = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name && String(c.parentId || "") === String(parentId || "")
  );
  if (exist) return exist;

  return await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
  });
}

async function upsertLobbyMessage(channel, gameKey, payload) {
  const marker = `[[VIBE_LOBBY:${gameKey}]]`;
  const msgs = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const old = msgs?.find((m) => m.author?.id === channel.client.user.id && m.content?.includes(marker));

  if (old) return await old.edit(payload);
  return await channel.send({ ...payload, content: `${marker}\n${payload.content}` });
}

function buildLobbyPayload(gameKey) {
  if (gameKey === "counting") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("lobby:counting:start").setLabel("▶️ 開始 Counting").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("lobby:counting:pause").setLabel("⏸️ 暫停").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("lobby:counting:stop").setLabel("⏹️ 停止").setStyle(ButtonStyle.Danger),
    );

    return {
      content: "🟩 **Counting 大廳**\n（目前：由按鈕控制開始/暫停/停止）\n開始後大家直接在聊天室輸入數字接龍。",
      components: [row],
    };
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lobby:create:${gameKey}`)
      .setLabel(`建立 ${GAME_ZH[gameKey]} 房間`)
      .setStyle(ButtonStyle.Success)
  );

  return {
    content: `🎮 **${GAME_ZH[gameKey]} 大廳**\n按按鈕會建立你的私人房間（一次只能一間）。`,
    components: [row],
  };
}

async function ensureLobbyChannelsAndButtons(guild) {
  const catLobby = await ensureCategory(guild, CATEGORY_LOBBIES);

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
  });

  const hlLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.hl,
    parentId: catLobby.id,
    overwrites: lobbyOverwrites,
  });

  const countingLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.counting,
    parentId: catLobby.id,
    overwrites: lobbyOverwrites,
  });

  await upsertLobbyMessage(guessLobby, "guess", buildLobbyPayload("guess"));
  await upsertLobbyMessage(hlLobby, "hl", buildLobbyPayload("hl"));
  await upsertLobbyMessage(countingLobby, "counting", buildLobbyPayload("counting"));

  // 讓 games.js 能靠「頻道名字」判斷 counting lobby
  // （不依賴記憶，重啟也不怕）
  return { guessLobby, hlLobby, countingLobby };
}

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

  userRoomMap.set(interaction.user.id, { channelId: room.id, gameKey });
  roomOwnerMap.set(room.id, interaction.user.id);
  pingActivity(room.id, interaction.user.id);

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`room:close:${interaction.user.id}`)
      .setLabel("🗑️ 關閉房間")
      .setStyle(ButtonStyle.Danger)
  );

  await room.send({
    content: `✅ 房間建立完成：<@${interaction.user.id}>\n遊戲：**${GAME_ZH[gameKey]}**`,
    components: [closeRow],
  });

  // auto start games
  if (gameKey === "hl") {
    const fake = { user: interaction.user, channel: room };
    await gamesMod.games.hlStart(fake, room.id, 13);
  }

  if (gameKey === "guess") {
    gamesMod.games.guessStart(room.id, { min: 1, max: 100 });
    await room.send("🟦 Guess 已開始！範圍：**1 ~ 100**（直接在聊天室打數字猜）");
  }

  return room;
}

async function handleInteraction(interaction) {
  // ✅ 只處理 lobby/room 的 customId，其他不要碰
  const id = interaction.customId || "";
  if (!id.startsWith("lobby:") && !id.startsWith("room:")) return false;

  // ===== 建房 =====
  if (id.startsWith("lobby:create:")) {
    const gameKey = id.split(":")[2];

    const existing = userRoomMap.get(interaction.user.id);
    if (existing?.channelId) {
      await interaction.reply({
        content: `⚠️ 你目前已有一間房：<#${existing.channelId}>\n要關掉它再建立 **${GAME_ZH[gameKey]}** 嗎？`,
        flags: MessageFlags.Ephemeral,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`room:switch:close:${gameKey}:${existing.channelId}`)
              .setLabel("關掉舊房並建立新房")
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`room:switch:goto:${existing.channelId}`)
              .setLabel("回到舊房")
              .setStyle(ButtonStyle.Secondary)
          ),
        ],
      });
      return true;
    }

    // ⭐ 用 deferUpdate：不在大廳留下「XXX 建房」訊息
    await interaction.deferUpdate().catch(() => {});
    const room = await createGameRoom(interaction, gameKey);

    // ✅ 只回覆給玩家自己看
    await interaction.followUp({
      content: `✅ 已建立你的房間：<#${room.id}>`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});

    return true; // ⭐⭐⭐ VERY IMPORTANT
  }

  // ===== 回舊房 =====
  if (id.startsWith("room:switch:goto:")) {
    const oldChannelId = id.split(":")[3];
    await interaction.update({ content: `👉 回到你的房間：<#${oldChannelId}>`, components: [] }).catch(() => {});
    return true;
  }

  // ===== 關舊開新 =====
  if (id.startsWith("room:switch:close:")) {
    await interaction.deferUpdate().catch(() => {});
    const [, , , newGameKey, oldChannelId] = id.split(":");

    const oldCh = interaction.guild.channels.cache.get(oldChannelId);
    if (oldCh) await oldCh.delete("switch room").catch(() => {});

    userRoomMap.delete(interaction.user.id);
    roomOwnerMap.delete(oldChannelId);

    const room = await createGameRoom(interaction, newGameKey);

    await interaction.followUp({
      content: `✅ 已關閉舊房並建立新房：<#${room.id}>`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});

    return true;
  }

  // ===== counting start/pause/stop =====
  if (id === "lobby:counting:start") {
    await interaction.deferUpdate().catch(() => {});
    gamesMod.games.countingStart(interaction.channelId, 1);
    await interaction.channel.send("🟩 **Counting 已開始！** 請輸入 **1️⃣** 開始接龍。");
    return true;
  }

  if (id === "lobby:counting:pause") {
    await interaction.deferUpdate().catch(() => {});
    gamesMod.games.countingPause(interaction.channelId);
    await interaction.channel.send("⏸️ **Counting 已暫停**（此時任何訊息都會被刪除）。");
    return true;
  }

  if (id === "lobby:counting:stop") {
    await interaction.deferUpdate().catch(() => {});
    gamesMod.games.countingStop(interaction.channelId);
    await interaction.channel.send("⏹️ **Counting 已停止**（此時任何訊息都會被刪除）。");
    return true;
  }

  // ===== 房間關閉 =====
  if (id.startsWith("room:close:")) {
    const ownerId = id.split(":")[2];
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "❌ 只有房主能關房。", flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferUpdate().catch(() => {});
    const ch = interaction.channel;

    userRoomMap.delete(ownerId);
    roomOwnerMap.delete(ch.id);

    gamesMod.games.guessStop(ch.id);
    gamesMod.games.hlStop(ch.id);

    await ch.delete("room closed").catch(() => {});
    return true;
  }

  return true;
}

module.exports = {
  ensureLobbyChannelsAndButtons,
  handleInteraction,
  pingActivity,

  // for debugging
  _maps: { userRoomMap, roomOwnerMap, lastActivityMap },
};