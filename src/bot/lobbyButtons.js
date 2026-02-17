"use strict";

/**
 * src/bot/lobbyButtons.js
 * ✅ /install 後在各遊戲大廳發按鈕
 * ✅ 按鈕 -> 開私人房間
 * ✅ 一人同時只能一間房：有舊房先詢問「關舊開新 / 回舊房」
 *
 * ✅ 修正：
 * 1) 建房結果改用 ephemeral（只有按的人看得到），不在大廳公告
 * 2) counting 大廳允許 everyone 發言（才能打數字）
 * 3) 房間 AFK/遊戲結束 自動關房
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
// channelId -> { ownerId, gameKey }
const roomMetaMap = new Map();

// channelId -> timers/collectors
const roomRuntime = new Map();

/** ============== helpers ============== */
function sanitizeName(name) {
  return String(name || "player")
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .trim()
    .slice(0, 20) || "player";
}

function channelLink(guildId, channelId) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
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

/** ============== lobby UI ============== */
function buildLobbyPayload(gameKey) {
  // ✅ counting 大廳不放 start/stop（你說要移到管理員區）
  if (gameKey === "counting") {
    return {
      content:
        "🟩 **Counting 大廳**\n" +
        "直接從 **1** 開始在聊天室輸入數字接龍。\n" +
        "（⚙️ 開始/停止/暫停已移到管理員區）",
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

/** ============== AFK & auto-close ============== */
function clearRoomRuntime(channelId) {
  const rt = roomRuntime.get(channelId);
  if (!rt) return;

  if (rt.warnTimer) clearTimeout(rt.warnTimer);
  if (rt.closeTimer) clearTimeout(rt.closeTimer);

  try { rt.msgCollector?.stop("cleanup"); } catch (_) {}
  try { rt.btnCollector?.stop("cleanup"); } catch (_) {}

  roomRuntime.delete(channelId);
}

async function closeRoom(channel, reason = "room closed") {
  if (!channel || channel?.deleted) return;

  const channelId = channel.id;
  const meta = roomMetaMap.get(channelId);
  const ownerId = meta?.ownerId;

  // 清狀態
  try { gamesMod.games.guessStop(channelId); } catch (_) {}
  try { gamesMod.games.hlStop(channelId); } catch (_) {}

  // 清 mapping
  if (ownerId) userRoomMap.delete(ownerId);
  roomMetaMap.delete(channelId);

  clearRoomRuntime(channelId);

  // 刪頻道
  try {
    await channel.delete(reason);
  } catch (_) {}
}

async function closeRoomSoon(channel, ms, reason) {
  if (!channel || channel?.deleted) return;
  setTimeout(() => closeRoom(channel, reason), ms);
}

async function sendCountdown(channel) {
  // 30s 倒數（30/20/10/5/4/3/2/1）
  const steps = [30, 20, 10, 5, 4, 3, 2, 1];
  let msg = null;

  try {
    msg = await channel.send("⏳ **30 秒後**若無操作，房間將自動關閉。");
  } catch (_) {
    return;
  }

  for (const s of steps.slice(1)) {
    await new Promise((r) => setTimeout(r, (steps[steps.indexOf(s) - 1] - s) * 1000));
    try {
      await msg.edit(`⏳ **${s} 秒後**若無操作，房間將自動關閉。`);
    } catch (_) {}
  }
}

function armAfkTimers(channel) {
  const channelId = channel.id;
  const rt = roomRuntime.get(channelId);
  if (!rt) return;

  // reset timers
  if (rt.warnTimer) clearTimeout(rt.warnTimer);
  if (rt.closeTimer) clearTimeout(rt.closeTimer);

  // 90 秒 -> 送警告 + 倒數訊息
  rt.warnTimer = setTimeout(async () => {
    await sendCountdown(channel);
  }, 90 * 1000);

  // 120 秒 -> 關房
  rt.closeTimer = setTimeout(async () => {
    await closeRoom(channel, "AFK auto close");
  }, 120 * 1000);
}

function shouldAutoCloseByBotMessage(content) {
  if (!content) return false;
  // 依你 games.js 目前輸出的文字做判斷
  if (content.includes("猜中了")) return true;      // Guess 猜中
  if (content.includes("HL 結束")) return true;     // HL 結束
  if (content.includes("🛑 HL 結束")) return true;
  return false;
}

function setupRoomCollectors(room) {
  const channelId = room.id;

  const msgCollector = room.createMessageCollector({
    time: 24 * 60 * 60 * 1000, // 1天（夠長就好）
  });

  msgCollector.on("collect", async (m) => {
    // 玩家行為 -> reset AFK
    if (!m.author?.bot) {
      armAfkTimers(room);
      return;
    }

    // ✅ 偵測遊戲結束 -> 幾秒後關房（讓玩家看一下結果）
    if (shouldAutoCloseByBotMessage(m.content)) {
      await closeRoomSoon(room, 5000, "game finished");
    }
  });

  // 任何按鈕點擊也算活動（HL 是按鈕式）
  const btnCollector = room.createMessageComponentCollector({
    time: 24 * 60 * 60 * 1000,
  });

  btnCollector.on("collect", async () => {
    armAfkTimers(room);
  });

  roomRuntime.set(channelId, {
    warnTimer: null,
    closeTimer: null,
    msgCollector,
    btnCollector,
  });

  // 立刻開始計時
  armAfkTimers(room);
}

/** ============== install: create lobbies + buttons ============== */
async function ensureLobbyChannelsAndButtons(guild) {
  const catLobby = await ensureCategory(guild, CATEGORY_LOBBIES);

  // guess/hl 大廳：只有機器人可說話；大家可看/可按按鈕
  const lobbyOverwritesLocked = [
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

  // ✅ counting 大廳：大家要能打字（才能接龍）
  const lobbyOverwritesCounting = [
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

  const guessLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.guess,
    parentId: catLobby.id,
    overwrites: lobbyOverwritesLocked,
  });

  const hlLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.hl,
    parentId: catLobby.id,
    overwrites: lobbyOverwritesLocked,
  });

  const countingLobby = await ensureTextChannel(guild, {
    name: LOBBY_CHANNELS.counting,
    parentId: catLobby.id,
    overwrites: lobbyOverwritesCounting,
  });

  await upsertLobbyMessage(guessLobby, "guess", buildLobbyPayload("guess"));
  await upsertLobbyMessage(hlLobby, "hl", buildLobbyPayload("hl"));
  await upsertLobbyMessage(countingLobby, "counting", buildLobbyPayload("counting"));

  return { guessLobby, hlLobby, countingLobby };
}

/** ============== room create ============== */
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
  roomMetaMap.set(room.id, { ownerId: interaction.user.id, gameKey });

  // ✅ AFK + 遊戲結束自動關房
  setupRoomCollectors(room);

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`room:close:${interaction.user.id}`)
      .setLabel("關閉房間")
      .setStyle(ButtonStyle.Danger)
  );

  await room.send({
    content: `✅ 房間建立完成：<@${interaction.user.id}>\n遊戲：**${GAME_ZH[gameKey]}**\n（90 秒無操作會提示，120 秒自動關房）`,
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

/** ============== buttons ============== */
async function handleButton(interaction) {
  if (!interaction.isButton()) return false;

  const id = interaction.customId;

  // === 建房 ===
  if (id.startsWith("lobby:create:")) {
    const gameKey = id.split(":")[2];
    const existing = userRoomMap.get(interaction.user.id);

    // ✅ 一律先 deferReply（ephemeral），避免 3 秒超時
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    if (existing?.channelId) {
      await interaction.editReply({
        content: `⚠️ 你目前已有一間房：<#${existing.channelId}>\n要關掉它再建立 **${GAME_ZH[gameKey]}** 嗎？`,
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

    const room = await createGameRoom(interaction, gameKey);

    await interaction.editReply({
      content: `✅ 已建立房間：<#${room.id}>`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("前往房間")
            .setURL(channelLink(interaction.guildId, room.id))
        ),
      ],
    });

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
    const [, , , newGameKey, oldChannelId] = id.split(":");

    // 先把提示訊息更新掉（避免按完沒反應）
    await interaction.update({
      content: "⏳ 正在關閉舊房並建立新房...",
      components: [],
    }).catch(() => {});

    const oldCh = interaction.guild.channels.cache.get(oldChannelId);
    if (oldCh) {
      // 清狀態 + mapping
      const meta = roomMetaMap.get(oldChannelId);
      if (meta?.ownerId) userRoomMap.delete(meta.ownerId);
      roomMetaMap.delete(oldChannelId);
      clearRoomRuntime(oldChannelId);

      await oldCh.delete("switch room").catch(() => {});
    }

    const room = await createGameRoom(interaction, newGameKey);

    await interaction.followUp({
      content: `✅ 已建立新房：<#${room.id}>`,
      flags: MessageFlags.Ephemeral,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("前往房間")
            .setURL(channelLink(interaction.guildId, room.id))
        ),
      ],
    }).catch(() => {});

    return true;
  }

  // === counting 舊按鈕（保留防呆）===
  if (id === "lobby:counting:start" || id === "lobby:counting:stop") {
    await interaction.reply({
      content: "⚙️ Counting 的開始/停止/暫停已移到管理員區。",
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  // === 房間關閉 ===
  if (id.startsWith("room:close:")) {
    const ownerId = id.split(":")[2];
    if (interaction.user.id !== ownerId) {
      await interaction.reply({
        content: "❌ 只有房主能關房。",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return true;
    }

    await interaction.deferUpdate().catch(() => {});
    await closeRoom(interaction.channel, "room closed by owner");
    return true;
  }

  return false;
}

module.exports = {
  ensureLobbyChannelsAndButtons,
  handleButton,
};