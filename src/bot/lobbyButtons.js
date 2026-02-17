"use strict";

/**
 * src/bot/lobbyButtons.js
 * ✅ /install 後建立：
 *    - 遊戲大廳（每遊戲一個大廳 + 按鈕）
 *    - 積分區（面板）
 *    - 管理員區（面板：counting 控制、積分/房間/警告/商城管理入口）
 * ✅ 建房按鈕回覆改成 Ephemeral（只有本人看到）
 * ✅ 一人同時只能一間房：詢問「關舊開新 / 回舊房」
 * ✅ AFK 自動關房：30 秒倒數（在同房間倒數，不會開新頻道）
 * ✅ 遊戲結束會關房（由 games.js 呼叫 closeRoomByChannel）
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
const pointsDb = require("../db/points"); // 你原本的 points.js（要有 getPoints/addPoints/topPoints 等）

// ====== names ======
const CATEGORY_LOBBIES = "🎮 遊戲大廳";
const CATEGORY_ROOMS = "🎲 遊戲房間";
const CATEGORY_POINTS = "🪙 積分區";
const CATEGORY_ADMIN = "🛠 管理員區";

const LOBBY_CHANNELS = {
  guess: "🟦-guess",
  hl: "🟥-hl",
  counting: "🟩-counting",
};

const POINTS_CHANNELS = {
  panel: "🪙-積分面板",
  shop: "🛒-積分商城",
  market: "🏷️-拍賣市場",
};

const ADMIN_CHANNELS = {
  panel: "🛠-管理面板",
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

// AFK
const roomActivity = new Map(); // channelId -> { lastAt, ownerId, timer, countdownTimer, countdownMsgId }
const AFK_SECONDS = 120;        // 2 分鐘無行動關房
const COUNTDOWN_SECONDS = 30;   // 先倒數 30 秒

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

  return await guild.channels.create({ name, type: ChannelType.GuildCategory });
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

async function upsertBotMessage(channel, marker, payload) {
  const msgs = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const old = msgs?.find(
    (m) => m.author?.id === channel.client.user.id && m.content?.includes(marker)
  );

  if (old) return await old.edit(payload);
  return await channel.send({ ...payload, content: `${marker}\n${payload.content}` });
}

// ====== Lobby payloads ======
function buildLobbyPayload(gameKey) {
  // counting 大廳：只說明（按鈕移到管理員區）
  if (gameKey === "counting") {
    return {
      content:
        "🟩 **Counting 大廳**\n" +
        "📌 規則：只能輸入數字接龍（非數字會刪除 + 記錄違規）\n" +
        "✅ 開始/暫停/結束由管理員面板控制",
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
    content: `🎮 **${GAME_ZH[gameKey]} 大廳**\n按按鈕建立私人房間（一次只能一間）。`,
    components: [row],
  };
}

// ====== Points payloads ======
function buildPointsPanel() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("points:me").setLabel("我的積分").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("points:top").setLabel("排行榜").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("points:bag").setLabel("背包").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("points:shop").setLabel("積分商城").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("points:market").setLabel("拍賣市場").setStyle(ButtonStyle.Success)
  );

  return {
    content: "🪙 **積分面板**\n用按鈕操作：查詢 / 排行 / 背包 / 商城 / 拍賣",
    components: [row1, row2],
  };
}

function buildAdminPanel() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin:counting:start").setLabel("🟢 開始 Counting").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("admin:counting:pause").setLabel("⏸ 暫停 Counting").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("admin:counting:stop").setLabel("🔴 結束 Counting").setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin:points").setLabel("玩家積分管理").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin:rooms").setLabel("房間管理").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("admin:warnings").setLabel("警告管理").setStyle(ButtonStyle.Primary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("admin:shop").setLabel("商城管理").setStyle(ButtonStyle.Success)
  );

  return {
    content: "🛠 **管理員面板**\n（Counting 控制 / 積分 / 房間 / 警告 / 商城）",
    components: [row1, row2, row3],
  };
}

function isAdmin(member) {
  if (!member) return false;
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// ====== Create channels & panels ======
async function ensureLobbyChannelsAndButtons(guild) {
  const catLobby = await ensureCategory(guild, CATEGORY_LOBBIES);

  // 大廳：只有機器人可說話；大家可看
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

  await upsertBotMessage(guessLobby, "[[VIBE_LOBBY:guess]]", buildLobbyPayload("guess"));
  await upsertBotMessage(hlLobby, "[[VIBE_LOBBY:hl]]", buildLobbyPayload("hl"));
  await upsertBotMessage(countingLobby, "[[VIBE_LOBBY:counting]]", buildLobbyPayload("counting"));

  return { guessLobby, hlLobby, countingLobby };
}

async function ensurePointsArea(guild) {
  const cat = await ensureCategory(guild, CATEGORY_POINTS);

  // 積分區：只有機器人可說話（你可自行調整）
  const overwrites = [
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

  const panel = await ensureTextChannel(guild, { name: POINTS_CHANNELS.panel, parentId: cat.id, overwrites });
  const shop = await ensureTextChannel(guild, { name: POINTS_CHANNELS.shop, parentId: cat.id, overwrites });
  const market = await ensureTextChannel(guild, { name: POINTS_CHANNELS.market, parentId: cat.id, overwrites });

  await upsertBotMessage(panel, "[[VIBE_POINTS:PANEL]]", buildPointsPanel());
  await upsertBotMessage(shop, "[[VIBE_POINTS:SHOP]]", { content: "🛒 **積分商城**\n（商品清單由管理員面板上架/下架）", components: [] });
  await upsertBotMessage(market, "[[VIBE_POINTS:MARKET]]", { content: "🏷️ **拍賣市場**\n（玩家可把背包物品拍賣，下一步做）", components: [] });

  return { panel, shop, market };
}

async function ensureAdminArea(guild) {
  const cat = await ensureCategory(guild, CATEGORY_ADMIN);

  // 管理員區：只有管理員 + 機器人可看
  const overwrites = [
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

  const panel = await ensureTextChannel(guild, { name: ADMIN_CHANNELS.panel, parentId: cat.id, overwrites });
  await upsertBotMessage(panel, "[[VIBE_ADMIN:PANEL]]", buildAdminPanel());
  return { panel };
}

// ====== Room close + AFK ======
async function closeRoomByChannel(channel, reason = "closed") {
  if (!channel) return;

  const meta = roomMetaMap.get(channel.id);
  if (meta?.ownerId) userRoomMap.delete(meta.ownerId);
  roomMetaMap.delete(channel.id);

  // 清狀態
  gamesMod.games.guessStop(channel.id);
  gamesMod.games.hlStop(channel.id);

  // 清 AFK timers
  const a = roomActivity.get(channel.id);
  if (a?.timer) clearTimeout(a.timer);
  if (a?.countdownTimer) clearInterval(a.countdownTimer);
  roomActivity.delete(channel.id);

  await channel.delete(reason).catch(() => {});
}

function scheduleAfkClose(channel, ownerId) {
  // 只有遊戲房間才做
  if (!roomMetaMap.has(channel.id)) return;

  // reset timers
  const prev = roomActivity.get(channel.id);
  if (prev?.timer) clearTimeout(prev.timer);
  if (prev?.countdownTimer) clearInterval(prev.countdownTimer);

  const obj = { lastAt: Date.now(), ownerId, timer: null, countdownTimer: null, countdownMsgId: null };
  roomActivity.set(channel.id, obj);

  obj.timer = setTimeout(async () => {
    // 先倒數 30 秒
    let left = COUNTDOWN_SECONDS;
    const msg = await channel.send(`⏳ **AFK 偵測：${left} 秒後關閉房間**（有任何動作會取消）`).catch(() => null);
    if (msg) obj.countdownMsgId = msg.id;

    obj.countdownTimer = setInterval(async () => {
      left -= 5;
      if (left <= 0) {
        clearInterval(obj.countdownTimer);
        obj.countdownTimer = null;
        await channel.send("🛑 AFK 關房。").catch(() => {});
        await closeRoomByChannel(channel, "AFK timeout");
        return;
      }
      if (msg) {
        await msg.edit(`⏳ **AFK 偵測：${left} 秒後關閉房間**（有任何動作會取消）`).catch(() => {});
      }
    }, 5000);
  }, AFK_SECONDS * 1000);
}

// 外部會呼叫：messageCreate / buttons
function pingActivity(channelId, userId) {
  const meta = roomMetaMap.get(channelId);
  if (!meta) return; // 非房間就不管
  if (userId && userId !== meta.ownerId) return; // 先簡化：只有房主行為算取消 AFK
  const guild = meta.guild;
  const ch = guild?.channels?.cache?.get(channelId);
  if (!ch) return;
  scheduleAfkClose(ch, meta.ownerId);
}

// ====== Create game room ======
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
  roomMetaMap.set(room.id, { ownerId: interaction.user.id, gameKey, guild });

  // 房內控制：關閉房間（房主可按）
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

  // 排程 AFK
  scheduleAfkClose(room, interaction.user.id);

  // 自動開始遊戲
  if (gameKey === "hl") {
    const fake = { user: interaction.user, channel: room };
    await gamesMod.games.hlStart(fake, room.id, 13);
  }

  if (gameKey === "guess") {
    gamesMod.games.guessStart(room.id, { min: 1, max: 100 });
    await room.send("🟦 **Guess 已開始！**\n範圍：**1 ~ 100**（直接在聊天室打數字猜）");
  }

  // games.js 需要能關房：註冊關房 callback
  gamesMod.setRoomCloser(async (channelId, why) => {
    const ch = guild.channels.cache.get(channelId);
    if (ch) await closeRoomByChannel(ch, why || "game ended");
  });

  return room;
}

// ====== interaction dispatcher ======
async function handleInteraction(interaction) {
  // ====== 建房 ======
  if (interaction.isButton() && interaction.customId.startsWith("lobby:create:")) {
    const gameKey = interaction.customId.split(":")[2];
    const existing = userRoomMap.get(interaction.user.id);

    // 已有房：詢問（ephemeral）
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

    // ✅ 建房成功訊息只給本人看（ephemeral）
    await interaction.reply({ content: "⏳ 正在建立房間...", flags: MessageFlags.Ephemeral });

    const room = await createGameRoom(interaction, gameKey);
    await interaction.editReply(`✅ 已建立房間：<#${room.id}>`);

    return true;
  }

  // ====== 已有房：回舊房 ======
  if (interaction.isButton() && interaction.customId.startsWith("room:switch:goto:")) {
    const oldChannelId = interaction.customId.split(":")[3];
    await interaction.update({
      content: `👉 回到你的房間：<#${oldChannelId}>`,
      components: [],
    }).catch(() => {});
    return true;
  }

  // ====== 已有房：關舊開新 ======
  if (interaction.isButton() && interaction.customId.startsWith("room:switch:close:")) {
    await interaction.update({ content: "⏳ 正在切換房間...", components: [] }).catch(() => {});
    const [, , , newGameKey, oldChannelId] = interaction.customId.split(":");

    const oldCh = interaction.guild.channels.cache.get(oldChannelId);
    if (oldCh) await oldCh.delete("switch room").catch(() => {});

    userRoomMap.delete(interaction.user.id);

    const room = await createGameRoom(interaction, newGameKey);
    await interaction.editReply(`✅ 已關閉舊房並建立新房：<#${room.id}>`).catch(() => {});
    return true;
  }

  // ====== 房間關閉 ======
  if (interaction.isButton() && interaction.customId.startsWith("room:close:")) {
    const ownerId = interaction.customId.split(":")[2];
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "❌ 只有房主能關房。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.deferUpdate().catch(() => {});
    await closeRoomByChannel(interaction.channel, "room closed");
    return true;
  }

  // ====== 積分面板 ======
  if (interaction.isButton() && interaction.customId.startsWith("points:")) {
    const key = interaction.customId.split(":")[1];
    const uid = interaction.user.id;

    if (key === "me") {
      const p = (await pointsDb.getPoints?.(uid).catch(() => 0)) ?? 0;
      await interaction.reply({ content: `🪙 你的積分：**${p}**`, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (key === "top") {
      const top = (await pointsDb.topPoints?.(10).catch(() => [])) ?? [];
      const text =
        top.length === 0
          ? "（目前沒有資料）"
          : top
              .map((x, i) => `**${i + 1}.** <@${x.userId}> - **${x.points}**`)
              .join("\n");
      await interaction.reply({ content: `🏆 **積分排行榜**\n${text}`, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (key === "bag") {
      await interaction.reply({ content: "🎒 背包：下一步接上資料庫（先把面板做齊）。", flags: MessageFlags.Ephemeral });
      return true;
    }

    if (key === "shop") {
      await interaction.reply({ content: "🛒 商城：下一步由管理員上架/下架商品。", flags: MessageFlags.Ephemeral });
      return true;
    }

    if (key === "market") {
      await interaction.reply({ content: "🏷️ 拍賣市場：下一步做玩家上架/競標流程。", flags: MessageFlags.Ephemeral });
      return true;
    }
  }

  // ====== 管理員面板 ======
  if (interaction.isButton() && interaction.customId.startsWith("admin:")) {
    if (!isAdmin(interaction.member)) {
      await interaction.reply({ content: "❌ 你沒有權限。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const [, section, action] = interaction.customId.split(":");

    if (section === "counting") {
      // counting 控制都在管理員面板
      if (action === "start") {
        gamesMod.games.countingStart(LOBBY_CHANNELS.counting /* 不對：這是 name */);
        // 正確做法：直接在「🟩-counting」頻道啟動
        const ch = interaction.guild.channels.cache.find(c => c.name === LOBBY_CHANNELS.counting);
        if (!ch) {
          await interaction.reply({ content: "❌ 找不到 counting 大廳頻道。", flags: MessageFlags.Ephemeral });
          return true;
        }
        gamesMod.games.countingStart(ch.id, 1);
        await interaction.reply({ content: "🟢 已開始 Counting（到 🟩-counting 輸入 1）。", flags: MessageFlags.Ephemeral });
        await ch.send("🟢 **Counting 開始！**\n➡️ 請輸入：`1` 來開始接龍 ✅");
        return true;
      }

      if (action === "pause") {
        const ch = interaction.guild.channels.cache.find(c => c.name === LOBBY_CHANNELS.counting);
        if (!ch) {
          await interaction.reply({ content: "❌ 找不到 counting 大廳頻道。", flags: MessageFlags.Ephemeral });
          return true;
        }
        gamesMod.games.countingStop(ch.id);
        await interaction.reply({ content: "⏸ 已暫停 Counting。", flags: MessageFlags.Ephemeral });
        await ch.send("⏸ **Counting 已暫停**");
        return true;
      }

      if (action === "stop") {
        const ch = interaction.guild.channels.cache.find(c => c.name === LOBBY_CHANNELS.counting);
        if (!ch) {
          await interaction.reply({ content: "❌ 找不到 counting 大廳頻道。", flags: MessageFlags.Ephemeral });
          return true;
        }
        gamesMod.games.countingStop(ch.id);
        await interaction.reply({ content: "🔴 已結束 Counting。", flags: MessageFlags.Ephemeral });
        await ch.send("🔴 **Counting 已結束**");
        return true;
      }
    }

    // 其他管理入口先留骨架
    if (section === "points") {
      await interaction.reply({ content: "🛠 玩家積分管理：下一步做加減分/重置/封鎖。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (section === "rooms") {
      await interaction.reply({ content: "🛠 房間管理：下一步做查看所有房間/強制關房。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (section === "warnings") {
      await interaction.reply({ content: "🛠 警告管理：下一步做查詢/解除/永久。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (section === "shop") {
      await interaction.reply({ content: "🛠 商城管理：下一步做上架/下架/改價。", flags: MessageFlags.Ephemeral });
      return true;
    }
  }

  return false;
}

// ====== install helper ======
async function installAll(guild) {
  await ensureLobbyChannelsAndButtons(guild);
  await ensurePointsArea(guild);
  await ensureAdminArea(guild);
}

module.exports = {
  installAll,
  handleInteraction,
  pingActivity,
  closeRoomByChannel,
};