"use strict";

/**
 * ✅ 只用按鈕（建房用 ephemeral）
 * ✅ 一人只能一間房（有舊房 -> 問 關舊開新/回舊房）
 * ✅ 不在大廳公開刷建立房間訊息
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

const games = require("./games");
const system = require("./system");

const GAME_ZH = { guess: "猜數字", hl: "HL", counting: "Counting" };

function sanitizeName(name) {
  return String(name || "player").replace(/[^\p{L}\p{N}\- _]/gu, "").trim().slice(0, 20) || "player";
}

async function ensureCategory(guild, name) {
  const exist = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  if (exist) return exist;
  return await guild.channels.create({ name, type: ChannelType.GuildCategory });
}

async function createRoom(interaction, gameKey) {
  const guild = interaction.guild;
  const ids = system.getSystemIds();

  const catRooms =
    (ids.catRoomsId && guild.channels.cache.get(ids.catRoomsId)) ||
    (await ensureCategory(guild, system.CATEGORY_ROOMS));

  const creatorName = sanitizeName(interaction.member?.displayName || interaction.user.username);
  const channelName = `${GAME_ZH[gameKey]}+${creatorName}`.replace(/\s+/g, "-").slice(0, 90);

  const warnRoleId = ids.warnRoleId;
  const warnPermRoleId = ids.warnPermRoleId;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    ...(warnRoleId ? [{ id: warnRoleId, deny: [PermissionsBitField.Flags.ViewChannel] }] : []),
    ...(warnPermRoleId ? [{ id: warnPermRoleId, deny: [PermissionsBitField.Flags.ViewChannel] }] : []),
    {
      id: interaction.user.id,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
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
    topic: `[VIBE_SYS] room:${gameKey} owner:${interaction.user.id}`,
  });

  // 註冊房間
  const s = system.sysState();
  s.rooms[interaction.user.id] = { channelId: room.id, gameKey };
  s.roomActivity[room.id] = { lastTs: Date.now(), ownerId: interaction.user.id };
  require("./storage").writeState(s);

  // AFK
  system.scheduleAfk(room.id, interaction.user.id, interaction.client);

  // room control
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`room:close:${interaction.user.id}`).setLabel("關閉房間").setStyle(ButtonStyle.Danger)
  );

  await room.send({ content: `✅ 房間建立完成：<@${interaction.user.id}>\n遊戲：**${GAME_ZH[gameKey]}**`, components: [row] });

  // auto start
  if (gameKey === "hl") {
    const fake = { user: interaction.user, channel: room };
    await games.games.hlStart(fake, room.id, 13);
  } else if (gameKey === "guess") {
    games.games.guessStart(room.id, { min: 1, max: 100 });
    await room.send("🟦 Guess 已開始！範圍：**1 ~ 100**（直接在聊天室打數字猜）");
  }

  return room;
}

async function handleInteraction(interaction) {
  if (!interaction.isButton()) return false;

  // 防封鎖（警告/永久）
  if (interaction.guild && interaction.member) {
    const blocked = await system.isBlocked(interaction.member).catch(() => false);
    if (blocked) {
      await interaction.reply({ content: "⛔ 你目前被限制，不能建立/加入遊戲房間。", flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }
  }

  const id = interaction.customId;

  // ===== 建房 =====
  if (id.startsWith("lobby:create:")) {
    const gameKey = id.split(":")[2];

    // counting 不建房：它是大廳玩法
    if (gameKey === "counting") {
      await interaction.reply({ content: "🟩 Counting 不需要建房，直接在 🟩-counting 輸入數字接龍。", flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }

    const s = system.sysState();
    const existing = s.rooms[interaction.user.id];

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

    await interaction.reply({ content: "⏳ 建立房間中…", flags: MessageFlags.Ephemeral }).catch(() => {});
    const room = await createRoom(interaction, gameKey);

    await interaction.editReply({ content: `✅ 已建立房間：<#${room.id}>`, components: [] }).catch(() => {});
    return true;
  }

  // ===== 回舊房 =====
  if (id.startsWith("room:switch:goto:")) {
    const oldChannelId = id.split(":")[3];
    await interaction.update({ content: `👉 回到你的房間：<#${oldChannelId}>`, components: [] }).catch(() => {});
    return true;
  }

  // ===== 關舊開新 =====
  if (id.startsWith("room:switch:close:")) {
    const [, , , newGameKey, oldChannelId] = id.split(":");

    await interaction.update({ content: "⏳ 正在關閉舊房並建立新房…", components: [] }).catch(() => {});

    const oldCh = interaction.guild.channels.cache.get(oldChannelId);
    if (oldCh) await oldCh.delete("switch room").catch(() => {});

    // 清狀態
    const s = system.sysState();
    delete s.rooms[interaction.user.id];
    delete s.roomActivity[oldChannelId];
    require("./storage").writeState(s);

    const room = await createRoom(interaction, newGameKey);
    await interaction.editReply({ content: `✅ 已建立新房：<#${room.id}>`, components: [] }).catch(() => {});
    return true;
  }

  // ===== 房間關閉 =====
  if (id.startsWith("room:close:")) {
    const ownerId = id.split(":")[2];
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: "❌ 只有房主能關房。", flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }

    await interaction.deferUpdate().catch(() => {});
    const ch = interaction.channel;

    // 清狀態
    const s = system.sysState();
    delete s.rooms[ownerId];
    delete s.roomActivity[ch.id];
    require("./storage").writeState(s);

    games.games.guessStop(ch.id);
    games.games.hlStop(ch.id);

    await ch.delete("room closed").catch(() => {});
    return true;
  }

  // ===== 管理員面板：Counting =====
  if (id === "admin:counting:start") {
    if (!system.memberIsAdmin?.(interaction.member) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({ content: "❌ 只有管理員能操作。", flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }
    const ids = system.getSystemIds();
    const countingLobbyId = ids.countingLobbyId;
    if (!countingLobbyId) {
      await interaction.reply({ content: "⚠️ 找不到 counting 大廳，請先 /install。", flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }
    games.games.countingStart(countingLobbyId, 1);
    await interaction.reply({ content: "🟩 Counting 已開始！請到 🟩-counting 輸入 **1** 開始。", flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }

  if (id === "admin:counting:stop") {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({ content: "❌ 只有管理員能操作。", flags: MessageFlags.Ephemeral }).catch(() => {});
      return true;
    }
    const ids = system.getSystemIds();
    const countingLobbyId = ids.countingLobbyId;
    if (countingLobbyId) games.games.countingStop(countingLobbyId);
    await interaction.reply({ content: "🟥 Counting 已停止。", flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }

  // ===== 玩家積分面板 =====
  if (id === "points:me") {
    const p = require("./points").getPoints(interaction.user.id);
    await interaction.reply({ content: `💰 你的積分：**${p}**`, flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }

  if (id === "points:rank") {
    const top = require("./points").top(10);
    const lines = top.map((x, i) => `${i + 1}. <@${x.uid}>：**${x.p}**`);
    await interaction.reply({
      content: `🏆 排行榜 TOP 10\n${lines.join("\n") || "（目前沒資料）"}`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  if (id === "points:bag") {
    const inv = require("./points").ensureInv(interaction.user.id);
    await interaction.reply({
      content: `🎒 你的背包：\n${inv.length ? inv.map((x) => `• ${x}`).join("\n") : "（空）"}`,
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  // 管理面板其他按鈕先留 placeholder（你要我做「完整商城/拍賣/管理」我們可以下一步補齊）
  if (id.startsWith("admin:")) {
    await interaction.reply({ content: "🛠 這個管理功能尚未實作完（下一步我可以補齊）。", flags: MessageFlags.Ephemeral }).catch(() => {});
    return true;
  }

  return false;
}

module.exports = { handleInteraction };