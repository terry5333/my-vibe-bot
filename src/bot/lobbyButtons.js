"use strict";

/**
 * src/bot/lobbyButtons.js
 * ✅ /install 後在各遊戲大廳貼按鈕
 * ✅ 按鈕 -> 開私人房間（回覆用 Ephemeral，只給點按的人看到）
 * ✅ 一人同時只能一間房：有舊房先詢問「關舊開新 / 回舊房」
 * ✅ 防止「按一次開多間」：同一使用者建房加鎖
 * ✅ 支援 /close 的確認按鈕（從 commands_admin.handleAdminCloseButtons 進來）
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
const adminCommands = require("./commands_admin");

// ====== 你系統用到的分類/頻道名稱 ======
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

// 建房鎖：userId -> true（避免按一下跑多次）
const createRoomLock = new Map();

// 活動偵測（你 index.js 會呼叫 pingActivity）
const lastActivityMap = new Map(); // channelId -> { ts, userId }

// ====== helpers ======
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
  // ✅ counting 大廳不建房：直接按鈕開始/停止（表情符號加上）
  if (gameKey === "counting") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("lobby:counting:start")
        .setLabel("🟩 開始 Counting")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("lobby:counting:stop")
        .setLabel("🟥 停止 Counting")
        .setStyle(ButtonStyle.Danger)
    );

    return {
      content:
        "🟩 **Counting 大廳**\n" +
        "按「開始」後，大家直接在聊天室輸入數字接龍。\n" +
        "✅ 正確會繼續，❌ 打錯就結束。",
      components: [row],
    };
  }

  // 其他遊戲：建私人房
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lobby:create:${gameKey}`)
      .setLabel(`✅ 建立 ${GAME_ZH[gameKey]} 房間`)
      .setStyle(ButtonStyle.Success)
  );

  return {
    content:
      `🎮 **${GAME_ZH[gameKey]} 大廳**\n` +
      `按按鈕會自動建立私人房間（一次只能一間）。\n` +
      `⚠️ 建房結果只會顯示給你自己看（別人不會看到）。`,
    components: [row],
  };
}

// ====== /install 用：建立大廳 + 貼按鈕 ======
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

// ====== 建立私人房 ======
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
      .setLabel("🧹 關閉房間")
      .setStyle(ButtonStyle.Danger)
  );

  await room.send({
    content: `✅ 房間建立完成：<@${interaction.user.id}>\n遊戲：**${GAME_ZH[gameKey]}**`,
    components: [closeRow],
  });

  // 自動開始遊戲
  if (gameKey === "hl") {
    // hlStart 需要 interaction.user / interaction.channel
    const fake = { user: interaction.user, channel: room };
    await gamesMod.games.hlStart(fake, room.id, 13);
  }

  if (gameKey === "guess") {
    gamesMod.games.guessStart(room.id, { min: 1, max: 100 });
    await room.send("🟦 Guess 已開始！範圍：**1 ~ 100**（直接在聊天室打數字猜）");
  }

  return room;
}

// ====== 供 index.js 呼叫：紀錄活動 ======
function pingActivity(channelId, userId) {
  lastActivityMap.set(channelId, { ts: Date.now(), userId });
}

// ====== 統一處理互動（index.js 會呼叫 handleInteraction） ======
async function handleInteraction(interaction) {
  // ✅ /close 的確認按鈕先處理
  if (interaction.isButton() && typeof adminCommands.handleAdminCloseButtons === "function") {
    const ok = await adminCommands.handleAdminCloseButtons(interaction);
    if (ok) return true;
  }

  if (!interaction.isButton()) return false;

  const id = interaction.customId;

  // === 建房 ===
  if (id.startsWith("lobby:create:")) {
    const gameKey = id.split(":")[2];

    // ✅ 建房加鎖（避免按一下跑多次/重複建房）
    if (createRoomLock.get(interaction.user.id)) {
      await interaction.reply({
        content: "⏳ 你剛剛已按下建立房間，正在處理中…",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return true;
    }
    createRoomLock.set(interaction.user.id, true);

    try {
      const existing = userRoomMap.get(interaction.user.id);
      if (existing?.channelId) {
        // 需要詢問 -> ephemeral
        await interaction.reply({
          content:
            `⚠️ 你目前已有一間房：<#${existing.channelId}>\n` +
            `要關掉它再建立 **${GAME_ZH[gameKey]}** 嗎？`,
          flags: MessageFlags.Ephemeral,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`room:switch:close:${gameKey}:${existing.channelId}`)
                .setLabel("🟥 關掉舊房並建立新房")
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(`room:switch:goto:${existing.channelId}`)
                .setLabel("↩️ 回到舊房")
                .setStyle(ButtonStyle.Secondary)
            ),
          ],
        });
        return true;
      }

      const room = await createGameRoom(interaction, gameKey);

      // ✅ 建房結果只給點按的人看到（不在大廳公開講）
      await interaction.reply({
        content: `✅ 已建立你的房間：<#${room.id}>`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});

      return true;
    } finally {
      // 解鎖
      createRoomLock.delete(interaction.user.id);
    }
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
    // 防連點：也鎖一下
    if (createRoomLock.get(interaction.user.id)) {
      await interaction.reply({
        content: "⏳ 正在處理中…",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return true;
    }
    createRoomLock.set(interaction.user.id, true);

    try {
      await interaction.deferUpdate().catch(() => {});
      const [, , , newGameKey, oldChannelId] = id.split(":");

      const oldCh = interaction.guild.channels.cache.get(oldChannelId);
      if (oldCh) await oldCh.delete("switch room").catch(() => {});

      userRoomMap.delete(interaction.user.id);

      const room = await createGameRoom(interaction, newGameKey);

      // ✅ 結果只給自己看
      await interaction.followUp({
        content: `✅ 已關閉舊房並建立新房：<#${room.id}>`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});

      return true;
    } finally {
      createRoomLock.delete(interaction.user.id);
    }
  }

  // === counting start/stop（大廳）===
  if (id === "lobby:counting:start") {
    await interaction.deferUpdate().catch(() => {});
    gamesMod.games.countingStart(interaction.channelId, 1);
    await interaction.channel.send("🟩 **Counting 開始！** 👉 請直接輸入 **1️⃣** 開始接龍。");
    return true;
  }

  if (id === "lobby:counting:stop") {
    await interaction.deferUpdate().catch(() => {});
    gamesMod.games.countingStop(interaction.channelId);
    await interaction.channel.send("🟥 **Counting 已停止。**");
    return true;
  }

  // === 房間關閉 ===
  if (id.startsWith("room:close:")) {
    const ownerId = id.split(":")[2];
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "❌ 只有房主能關房。", flags: MessageFlags.Ephemeral })
        .catch(() => {});
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
  handleInteraction,
  pingActivity,

  // （如果你想在別處用）
  userRoomMap,
};