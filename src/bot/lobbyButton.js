"use strict";

/**
 * 大廳按鈕：
 * ✅ HL（預設 1~13）
 * ✅ Guess（問範圍：快捷 + 自訂）
 * ✅ 若已有房間：問要關掉舊房開新，或回去舊房
 * ✅ 規則頻道：一顆按鈕查詢警告/違規時間
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const { createRoom, closeRoom, bumpActivity, scheduleAfkTimer, getRoomOfUser } = require("./roomManager");
const { getPunishInfoForUser } = require("./warnings");

const CAT_NAME = "🎮 遊戲系統";
const CH_LOBBY = "📢-遊戲大廳";
const CH_RULES = "📜-規則-警告查詢";

// customIds
const ID_HL_OPEN = "lobby:hl:open";
const ID_GUESS_OPEN = "lobby:guess:open";
const ID_DECISION_CLOSE_AND_OPEN = "room:decision:close_and_open";
const ID_DECISION_GO_BACK = "room:decision:go_back";
const ID_RULES_CHECK = "rules:check_punish";

const ID_HL_HIGHER = "hl:higher";
const ID_HL_LOWER = "hl:lower";
const ID_HL_EXACT = "hl:exact";

const ID_GUESS_RANGE_100 = "guess:range:100";
const ID_GUESS_RANGE_500 = "guess:range:500";
const ID_GUESS_RANGE_CUSTOM = "guess:range:custom";
const ID_GUESS_MODAL_RANGE = "guess:modal:range";
const ID_GUESS_MODAL_TRY = "guess:modal:try";
const ID_GUESS_TRY = "guess:try";

// in-memory game states per room channel
const hlState = new Map(); // channelId -> { base }
const guessState = new Map(); // channelId -> { min,max,secret }

// helpers
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function findChannelByName(guild, name) {
  return guild.channels.cache.find((c) => c.name === name);
}

async function ensureLobbyPosts(client) {
  // 只在已加入的 guild 裡處理
  for (const [, guild] of client.guilds.cache) {
    const lobby = findChannelByName(guild, CH_LOBBY);
    const rules = findChannelByName(guild, CH_RULES);
    if (!lobby || !rules) continue;

    // 1) Lobby buttons message (避免一直洗版：找最近 30 則自己的訊息是否有我們的按鈕)
    const recentLobby = await lobby.messages.fetch({ limit: 30 }).catch(() => null);
    const hasLobbyPost =
      recentLobby &&
      recentLobby.some(
        (m) =>
          m.author.id === client.user.id &&
          m.components?.some((row) => row.components?.some((c) => c.customId === ID_HL_OPEN))
      );

    if (!hasLobbyPost) {
      const e = new EmbedBuilder()
        .setTitle("🎮 遊戲大廳")
        .setDescription("按按鈕直接開一個私人房間開始玩（不用打指令）。\n\n• HL：預設 1~13，開房就先顯示底牌\n• Guess：選範圍後開始（單人）");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(ID_HL_OPEN).setLabel("🎴 HL").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(ID_GUESS_OPEN).setLabel("🔐 Guess").setStyle(ButtonStyle.Secondary)
      );

      await lobby.send({ embeds: [e], components: [row] });
    }

    // 2) Rules button message
    const recentRules = await rules.messages.fetch({ limit: 30 }).catch(() => null);
    const hasRulesPost =
      recentRules &&
      recentRules.some(
        (m) =>
          m.author.id === client.user.id &&
          m.components?.some((row) => row.components?.some((c) => c.customId === ID_RULES_CHECK))
      );

    if (!hasRulesPost) {
      const e = new EmbedBuilder()
        .setTitle("📜 規則 / 查詢")
        .setDescription("點下面按鈕查詢你的警告/永久狀態與限制時間。");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(ID_RULES_CHECK).setLabel("查詢我的警告").setStyle(ButtonStyle.Secondary)
      );

      await rules.send({ embeds: [e], components: [row] });
    }
  }
}

async function replyEphemeral(interaction, contentOrPayload) {
  const payload =
    typeof contentOrPayload === "string"
      ? { content: contentOrPayload, flags: MessageFlags.Ephemeral }
      : { ...contentOrPayload, flags: MessageFlags.Ephemeral };

  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

function decisionRow(targetGameKey) {
  // customId 帶上要開的遊戲
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ID_DECISION_CLOSE_AND_OPEN}:${targetGameKey}`)
      .setLabel("關掉目前房間並建立新的")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${ID_DECISION_GO_BACK}:${targetGameKey}`)
      .setLabel("回去目前房間")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function startHLRoom(channel, userId) {
  // 預設 1~13
  const base = randInt(1, 13);
  hlState.set(channel.id, { base, userId });

  const e = new EmbedBuilder()
    .setTitle("🎴 HL（1~13）")
    .setDescription(`底牌：**${base}**\n\n請選：下一張會 **更大 / 更小 / 剛好**？`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID_HL_HIGHER).setLabel("更大").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ID_HL_LOWER).setLabel("更小").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ID_HL_EXACT).setLabel("剛好").setStyle(ButtonStyle.Secondary)
  );

  await channel.send({ embeds: [e], components: [row] });
}

async function startGuessRoomAskRange(channel, userId) {
  const e = new EmbedBuilder()
    .setTitle("🔐 Guess")
    .setDescription("請先選範圍（單人遊戲）。");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ID_GUESS_RANGE_100).setLabel("1 ~ 100").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ID_GUESS_RANGE_500).setLabel("1 ~ 500").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ID_GUESS_RANGE_CUSTOM).setLabel("自訂").setStyle(ButtonStyle.Secondary)
  );

  await channel.send({ embeds: [e], components: [row] });
}

async function handleLobbyInteraction(interaction, { client }) {
  // -------- rules check ----------
  if (interaction.isButton() && interaction.customId === ID_RULES_CHECK) {
    const info = await getPunishInfoForUser(interaction.guild, interaction.user.id);
    const e = new EmbedBuilder().setTitle("📌 我的警告狀態").setDescription(info);
    return replyEphemeral(interaction, { embeds: [e] });
  }

  // -------- open HL / Guess ----------
  if (interaction.isButton() && (interaction.customId === ID_HL_OPEN || interaction.customId === ID_GUESS_OPEN)) {
    const gameKey = interaction.customId === ID_HL_OPEN ? "hl" : "guess";
    const gameNameZh = gameKey === "hl" ? "HL" : "Guess";

    const res = await createRoom(interaction, { gameKey, gameNameZh });

    if (!res) return; // 已回覆
    if (res.needDecision) {
      const ch = interaction.guild.channels.cache.get(res.existing.channelId);
      const where = ch ? `<#${ch.id}>` : "（找不到舊房間頻道）";
      return replyEphemeral(interaction, {
        content: `你現在已經有一間房間：${where}\n你要關掉舊房間，改開 **${gameNameZh}** 嗎？`,
        components: [decisionRow(gameKey)],
      });
    }

    // 新房間建立成功：回覆「只給他看到」並帶跳轉
    await replyEphemeral(interaction, { content: `✅ 已建立房間：<#${res.channel.id}>` });

    // 進房後開始遊戲（不用再提示公開訊息）
    if (gameKey === "hl") await startHLRoom(res.channel, res.userId);
    if (gameKey === "guess") await startGuessRoomAskRange(res.channel, res.userId);
    return;
  }

  // -------- decision buttons ----------
  if (interaction.isButton() && interaction.customId.startsWith(ID_DECISION_CLOSE_AND_OPEN)) {
    const [, targetGameKey] = interaction.customId.split(":").slice(-2); // ...:close_and_open:hl
    const existing = getRoomOfUser(interaction.user.id);
    if (existing) {
      await closeRoom(interaction.guild, interaction.user.id, "切換遊戲");
    }
    // 再建立新的
    const gameNameZh = targetGameKey === "hl" ? "HL" : "Guess";
    const res = await createRoom(interaction, { gameKey: targetGameKey, gameNameZh });
    if (!res || res.needDecision) return; // 理論上不會
    await replyEphemeral(interaction, { content: `✅ 已建立房間：<#${res.channel.id}>` });
    if (targetGameKey === "hl") await startHLRoom(res.channel, res.userId);
    if (targetGameKey === "guess") await startGuessRoomAskRange(res.channel, res.userId);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith(ID_DECISION_GO_BACK)) {
    const existing = getRoomOfUser(interaction.user.id);
    if (!existing) return replyEphemeral(interaction, "你目前沒有房間。");
    return replyEphemeral(interaction, { content: `回去你的房間：<#${existing.channelId}>` });
  }

  // -------- room gameplay: HL ----------
  if (interaction.isButton() && [ID_HL_HIGHER, ID_HL_LOWER, ID_HL_EXACT].includes(interaction.customId)) {
    const channel = interaction.channel;
    const state = hlState.get(channel.id);
    if (!state) return replyEphemeral(interaction, "❌ 找不到 HL 狀態（可能房間已重置）。");

    // 只能房主按
    if (interaction.user.id !== state.userId) {
      return replyEphemeral(interaction, "🚫 這是單人房，只有房主可以操作。");
    }

    bumpActivity(interaction.user.id);
    scheduleAfkTimer(interaction.guild, interaction.user.id);

    const base = state.base;
    const next = randInt(1, 13);

    let ok = false;
    if (interaction.customId === ID_HL_HIGHER) ok = next > base;
    if (interaction.customId === ID_HL_LOWER) ok = next < base;
    if (interaction.customId === ID_HL_EXACT) ok = next === base;

    const e = new EmbedBuilder()
      .setTitle("🎴 HL 結果")
      .setDescription(`底牌：**${base}** → 下一張：**${next}**\n\n結果：${ok ? "✅ 你猜對了！" : "❌ 你猜錯了！"}`);

    // 先回覆（ephemeral）再在房間公告
    await replyEphemeral(interaction, "已結算，房間即將關閉。");
    await channel.send({ embeds: [e] });

    // 結束馬上關
    setTimeout(async () => {
      await closeRoom(interaction.guild, interaction.user.id, "HL 結束");
    }, 1200);

    return;
  }

  // -------- room gameplay: Guess range pick ----------
  if (interaction.isButton() && [ID_GUESS_RANGE_100, ID_GUESS_RANGE_500, ID_GUESS_RANGE_CUSTOM].includes(interaction.customId)) {
    const channel = interaction.channel;

    // 找房主：我們把房主 userId 存在 guessState 之前先從 roomManager 查
    const room = getRoomOfUser(interaction.user.id);
    // 只有房主才能選（單人）
    // 但使用者可能在房間內按，此時 roomManager 的 userId 就是他
    // 若他不是房主，擋掉
    if (!room || room.channelId !== channel.id) {
      return replyEphemeral(interaction, "🚫 這是單人房，只有房主可以操作。");
    }

    bumpActivity(interaction.user.id);
    scheduleAfkTimer(interaction.guild, interaction.user.id);

    if (interaction.customId === ID_GUESS_RANGE_CUSTOM) {
      const modal = new ModalBuilder().setCustomId(ID_GUESS_MODAL_RANGE).setTitle("Guess 自訂範圍");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("min")
            .setLabel("最小值")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("max")
            .setLabel("最大值")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
      await interaction.showModal(modal);
      return;
    }

    const min = 1;
    const max = interaction.customId === ID_GUESS_RANGE_100 ? 100 : 500;
    const secret = randInt(min, max);
    guessState.set(channel.id, { min, max, secret, userId: interaction.user.id });

    await replyEphemeral(interaction, `✅ 已設定範圍：${min} ~ ${max}`);

    const e = new EmbedBuilder()
      .setTitle("🔐 Guess 開始")
      .setDescription(`範圍：**${min} ~ ${max}**\n按下面按鈕輸入你要猜的數字（不需要在頻道打字）。`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(ID_GUESS_TRY).setLabel("我想猜一個數字").setStyle(ButtonStyle.Primary)
    );

    await channel.send({ embeds: [e], components: [row] });
    return;
  }

  // -------- Guess custom range modal ----------
  if (interaction.isModalSubmit() && interaction.customId === ID_GUESS_MODAL_RANGE) {
    const channel = interaction.channel;
    const room = getRoomOfUser(interaction.user.id);
    if (!room || room.channelId !== channel.id) {
      return replyEphemeral(interaction, "🚫 只有房主可以設定。");
    }

    const min = Number(interaction.fields.getTextInputValue("min"));
    const max = Number(interaction.fields.getTextInputValue("max"));

    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      return replyEphemeral(interaction, "❌ 範圍無效，請確認 min < max 且都是數字。");
    }

    const secret = randInt(min, max);
    guessState.set(channel.id, { min, max, secret, userId: interaction.user.id });

    bumpActivity(interaction.user.id);
    scheduleAfkTimer(interaction.guild, interaction.user.id);

    await replyEphemeral(interaction, `✅ 已設定範圍：${min} ~ ${max}`);

    const e = new EmbedBuilder()
      .setTitle("🔐 Guess 開始")
      .setDescription(`範圍：**${min} ~ ${max}**\n按下面按鈕輸入你要猜的數字。`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(ID_GUESS_TRY).setLabel("我想猜一個數字").setStyle(ButtonStyle.Primary)
    );

    await channel.send({ embeds: [e], components: [row] });
    return;
  }

  // -------- Guess try button -> modal ----------
  if (interaction.isButton() && interaction.customId === ID_GUESS_TRY) {
    const channel = interaction.channel;
    const st = guessState.get(channel.id);
    if (!st) return replyEphemeral(interaction, "❌ 還沒設定範圍，請先選範圍。");
    if (interaction.user.id !== st.userId) return replyEphemeral(interaction, "🚫 單人房只有房主能玩。");

    bumpActivity(interaction.user.id);
    scheduleAfkTimer(interaction.guild, interaction.user.id);

    const modal = new ModalBuilder().setCustomId(ID_GUESS_MODAL_TRY).setTitle("Guess：輸入猜測");
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("n")
          .setLabel(`輸入一個數字（${st.min}~${st.max}）`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // -------- Guess try modal submit ----------
  if (interaction.isModalSubmit() && interaction.customId === ID_GUESS_MODAL_TRY) {
    const channel = interaction.channel;
    const st = guessState.get(channel.id);
    if (!st) return replyEphemeral(interaction, "❌ Guess 狀態不存在。");
    if (interaction.user.id !== st.userId) return replyEphemeral(interaction, "🚫 單人房只有房主能玩。");

    const n = Number(interaction.fields.getTextInputValue("n"));
    if (!Number.isFinite(n) || n < st.min || n > st.max) {
      return replyEphemeral(interaction, "❌ 數字不在範圍內。");
    }

    bumpActivity(interaction.user.id);
    scheduleAfkTimer(interaction.guild, interaction.user.id);

    if (n === st.secret) {
      await replyEphemeral(interaction, "✅ 你猜中了！房間即將關閉。");
      await channel.send(`🎉 猜中！答案就是 **${st.secret}**`);
      guessState.delete(channel.id);

      setTimeout(async () => {
        await closeRoom(interaction.guild, interaction.user.id, "Guess 結束");
      }, 1200);
      return;
    }

    // 縮範圍
    if (n < st.secret) st.min = Math.max(st.min, n + 1);
    else st.max = Math.min(st.max, n - 1);

    await replyEphemeral(interaction, `❌ 沒猜中！新範圍：${st.min} ~ ${st.max}`);

    // 若範圍壓到只剩一個也直接結束
    if (st.min === st.max) {
      await channel.send(`🧩 範圍只剩一個數了：**${st.min}**（答案：**${st.secret}**）`);
      guessState.delete(channel.id);
      setTimeout(async () => {
        await closeRoom(interaction.guild, interaction.user.id, "Guess 結束");
      }, 1200);
    }
    return;
  }
}

module.exports = { ensureLobbyPosts, handleLobbyInteraction };