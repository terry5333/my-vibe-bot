"use strict";

/**
 * src/bot/lobbyButtons.js
 * ✅ /install 後在各遊戲大廳發按鈕
 * ✅ 按鈕 -> 開私人房間
 * ✅ 一人同時只能一間房：有舊房先詢問「關舊開新 / 回舊房」
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

// userId -> { channelId, gameKey }
const userRoomMap = new Map();

function sanitizeName(name) {
  return String(name || "player")
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .trim()
    .slice(0, 20) || "player";
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

async function upsertLobbyMessage(channel, gameKey, payload) {
  const marker = `[[VIBE_LOBBY:${gameKey}]]`;
  const msgs = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const old = msgs?.find(
    (m) => m.author?.id === channel.client.user.id && m.content?.includes(marker)
  );

  if (old) return await old.edit(payload);
  return await channel.send({ ...payload, content: `${marker}\n${payload.content}` });
}

function buildLobbyPayload(gameKey) {
  if (gameKey === "counting") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("lobby:counting:start")
        .setLabel("開始 Counting")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("lobby:counting:stop")
        .setLabel("停止 Counting")
        .setStyle(ButtonStyle.Danger)
    );

    return {
      content:
        "🟩 **Counting 大廳**\n按「開始」後，大家直接在聊天室輸入數字接龍。",
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
    content: `🎮 **${GAME_ZH[gameKey]} 大廳**\n按按鈕會自動建立私人房間（一次只能一間）。`,
    components: [row],
  };
}

async function ensureLobbyChannelsAndButtons(guild) {
  const catLobby = await ensureCategory(guild, CATEGORY_LOBBIES);

  // 大廳：只有機器人可說話；大家可看/可按按鈕
  const lobbyOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.SendMessages],
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.ReadMessageHistory,
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

  return { guessLobby, hlLobby, countingLobby };
}

async function createGameRoom(interaction, gameKey) {
  const guild = interaction.guild;
  const catRooms = await ensureCategory(guild, CATEGORY_ROOMS);

  const creatorName = sanitizeName(interaction.member?.displayName || interaction.user.username);
  const channelName = `${GAME_ZH[gameKey]}+${creatorName}`.replace(/\s+/g, "-").slice(0, 90);

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

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`room:close:${interaction.user.id}`)
      .setLabel("關閉房間")
      .setStyle(ButtonStyle.Danger)
  );

  await room.send({
    content: `✅ 房間建立完成：<@${interaction.user.id}>\n遊戲：**${GAME_ZH[gameKey]}**`,
    components: [closeRow],
  });

  // 自動開始遊戲
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

async function handleButton(interaction) {
  if (!interaction.isButton()) return false;

  const id = interaction.customId;

  // === 建房 ===
  if (id.startsWith("lobby:create:")) {
    const gameKey = id.split(":")[2];

    const existing = userRoomMap.get(interaction.user.id);
    if (existing?.channelId) {
      // 需要詢問 -> 只能用 ephemeral
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

    // ✅ 不要跳出一個回覆訊息：用 deferUpdate()
    await interaction.deferUpdate().catch(() => {});
    const room = await createGameRoom(interaction, gameKey);

    // 在大廳由機器人通知（你大廳本來就只有機器人能發言）
    await interaction.channel.send(`✅ <@${interaction.user.id}> 已建立房間：<#${room.id}>`);
    return true;
  }

  // === 已有房：回舊房 ===
  if (id.startsWith("room:switch:goto:")) {
    const oldChannelId = id.split(":")[3];
    await interaction.update({
      content: `👉 回到你的房間：<#${oldChannelId}>`,
      components: [],
    }).catch(() => {});
    return true;
  }

  // === 已有房：關舊開新 ===
  if (id.startsWith("room:switch:close:")) {
    await interaction.deferUpdate().catch(() => {});
    const [, , , newGameKey, oldChannelId] = id.split(":");

    const oldCh = interaction.guild.channels.cache.get(oldChannelId);
    if (oldCh) await oldCh.delete("switch room").catch(() => {});

    userRoomMap.delete(interaction.user.id);

    const room = await createGameRoom(interaction, newGameKey);

    await interaction.channel.send(
      `✅ <@${interaction.user.id}> 已關閉舊房並建立新房：<#${room.id}>`
    );
    return true;
  }

  // === counting start/stop（大廳）===
  if (id === "lobby:counting:start") {
    await interaction.deferUpdate().catch(() => {});
    gamesMod.games.countingStart(interaction.channelId, 1);
    await interaction.channel.send("🟩 Counting 已開始！請直接輸入 **1** 開始接龍。");
    return true;
  }

  if (id === "lobby:counting:stop") {
    await interaction.deferUpdate().catch(() => {});
    gamesMod.games.countingStop(interaction.channelId);
    await interaction.channel.send("🛑 Counting 已停止。");
    return true;
  }

  // === 房間關閉 ===
  if (id.startsWith("room:close:")) {
    const ownerId = id.split(":")[2];
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "❌ 只有房主能關房。", flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferUpdate().catch(() => {});
    const ch = interaction.channel;

    userRoomMap.delete(ownerId);

    // 清狀態
    gamesMod.games.guessStop(ch.id);
    gamesMod.games.hlStop(ch.id);

    await ch.delete("room closed").catch(() => {});
    return true;
  }

  return false;
}

module.exports = {
  ensureLobbyChannelsAndButtons,
  handleButton,
};