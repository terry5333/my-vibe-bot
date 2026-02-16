"use strict";

/**
 * src/bot/games.js
 * ✅ 新增 RPS + BlackJack
 * ✅ export: { games, onMessage, onInteraction }
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// -------------------- 工具 --------------------
function rowOf(buttons) {
  return new ActionRowBuilder().addComponents(buttons);
}

function btn(id, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
}

// -------------------- RPS --------------------
// key: messageId -> state
const rpsGames = new Map();
/**
 * state = {
 *  channelId,
 *  opponentId|null,
 *  players: { [userId]: choice|null },
 *  done: boolean
 * }
 */
const RPS = ["rock", "paper", "scissors"];
const RPS_LABEL = { rock: "🪨 石頭", paper: "📄 布", scissors: "✂️ 剪刀" };

function rpsWinner(a, b) {
  if (a === b) return 0;
  if (a === "rock" && b === "scissors") return 1;
  if (a === "scissors" && b === "paper") return 1;
  if (a === "paper" && b === "rock") return 1;
  return -1;
}

function rpsComponents(disabled = false) {
  return [
    rowOf([
      btn("rps:rock", "🪨 石頭", ButtonStyle.Primary, disabled),
      btn("rps:paper", "📄 布", ButtonStyle.Primary, disabled),
      btn("rps:scissors", "✂️ 剪刀", ButtonStyle.Primary, disabled),
    ]),
  ];
}

function rpsStart({ channelId, messageAuthorId, opponentId = null }) {
  const content = opponentId
    ? `🪨📄✂️ **猜拳對決！** <@${messageAuthorId}> vs <@${opponentId}>\n兩位都按一次按鈕後會自動結算。`
    : `🪨📄✂️ **猜拳！** <@${messageAuthorId}> 請按按鈕出拳（你自己玩）。`;

  // 先回傳 UI，等 messageId 出來後由 onInteraction 內部補 state
  // 我們用特殊方式：先把 state 暫存在 channelId + author 做 fallback
  // 但更穩定方式是：在第一次按鈕 interaction 取得 message.id 後建立 state
  return { content, components: rpsComponents(false), _meta: { channelId, messageAuthorId, opponentId } };
}

// -------------------- Blackjack --------------------
// key: messageId -> state
const bjGames = new Map();
/**
 * state = {
 *  channelId,
 *  playerId,
 *  opponentId|null,
 *  deck: card[],
 *  playerHand: card[],
 *  dealerHand: card[],
 *  done: boolean
 * }
 */

function makeDeck() {
  // 4 副花色 * 13
  const suits = ["♠", "♥", "♦", "♣"];
  const deck = [];
  for (const s of suits) {
    for (let v = 1; v <= 13; v++) deck.push({ v, s });
  }
  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardLabel(c) {
  const map = { 1: "A", 11: "J", 12: "Q", 13: "K" };
  const face = map[c.v] || String(c.v);
  return `${c.s}${face}`;
}

function handValue(hand) {
  // A = 1 or 11, JQK = 10
  let sum = 0;
  let aces = 0;
  for (const c of hand) {
    if (c.v === 1) {
      aces++;
      sum += 1;
    } else if (c.v >= 11) sum += 10;
    else sum += c.v;
  }
  // 升級 A 為 11（+10）只要不爆
  while (aces > 0 && sum + 10 <= 21) {
    sum += 10;
    aces--;
  }
  return sum;
}

function bjRender(state) {
  const p = state.playerHand.map(cardLabel).join(" ");
  const d = state.dealerHand.map(cardLabel).join(" ");
  const pv = handValue(state.playerHand);
  const dv = handValue(state.dealerHand);

  const header = state.opponentId
    ? `🃏 **21點對決（同局）** <@${state.playerId}> vs <@${state.opponentId}>`
    : `🃏 **21點** <@${state.playerId}>`;

  const lines = [
    header,
    "",
    `👤 玩家手牌：${p}  (**${pv}**)`,
    `🤖 莊家手牌：${d}  (**${dv}**)`,
  ];

  return lines.join("\n");
}

function bjComponents(disabled = false) {
  return [
    rowOf([
      btn("bj:hit", "➕ 要牌", ButtonStyle.Success, disabled),
      btn("bj:stand", "✋ 停牌", ButtonStyle.Danger, disabled),
    ]),
  ];
}

function bjStart({ channelId, messageAuthorId, opponentId = null }) {
  // 先回 UI，state 由 onInteraction 取得 messageId 後建立
  const content = `🃏 **21點開始！** <@${messageAuthorId}> ${
    opponentId ? `vs <@${opponentId}>` : ""
  }\n（按「要牌/停牌」進行）`;

  return { content, components: bjComponents(false), _meta: { channelId, messageAuthorId, opponentId } };
}

// -------------------- interaction 處理 --------------------
async function onInteraction(interaction) {
  const { customId } = interaction;

  // 一律用 deferUpdate()，避免二次 reply
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate();
  }

  // 取得 messageId（遊戲都綁在同一則訊息）
  const messageId = interaction.message?.id;
  if (!messageId) return;

  // ---- RPS ----
  if (customId.startsWith("rps:")) {
    const choice = customId.split(":")[1];

    // 建立 state（若不存在）
    let st = rpsGames.get(messageId);
    if (!st) {
      // 從訊息內容推測：拿 mention 可能不可靠，所以這邊用最簡單：允許第一個按的人當 player1
      // 如果你要更嚴謹（必須只有發起者/對手能按），把 _meta 存在 DB 或把 messageId 回傳後存起來
      st = {
        channelId: interaction.channelId,
        opponentId: null,
        players: {},
        done: false,
      };
      rpsGames.set(messageId, st);
    }

    if (st.done) return;

    // 限制可玩的人（如果你想：只有訊息發起者/對手能按）
    // 這裡採「如果對手尚未設定」，第一個按的人就是玩家；如果第二個按的人不同就變成對戰
    if (!st.players[interaction.user.id]) st.players[interaction.user.id] = null;

    // 記錄出拳
    st.players[interaction.user.id] = choice;

    const playerIds = Object.keys(st.players);

    // 自己玩（只有一個玩家）→ bot 隨機出拳直接結算
    if (playerIds.length === 1 && !st.opponentId) {
      const u = playerIds[0];
      const botChoice = RPS[Math.floor(Math.random() * 3)];
      const res = rpsWinner(st.players[u], botChoice);

      st.done = true;

      const resultLine =
        res === 0
          ? "🤝 平手！"
          : res === 1
          ? `🎉 <@${u}> 贏了！`
          : `😵 <@${u}> 輸了！`;

      const content =
        `🪨📄✂️ **猜拳結算**\n` +
        `<@${u}>：${RPS_LABEL[st.players[u]]}\n` +
        `🤖 Bot：${RPS_LABEL[botChoice]}\n\n` +
        resultLine;

      await interaction.message.edit({ content, components: rpsComponents(true) });
      return;
    }

    // 對戰（兩個玩家都要選）
    if (playerIds.length >= 2) {
      const [a, b] = playerIds.slice(0, 2);

      if (!st.players[a] || !st.players[b]) {
        // 還沒選完，更新提示
        const content =
          `🪨📄✂️ **猜拳對決進行中**\n` +
          `<@${a}>：${st.players[a] ? "✅ 已出拳" : "⏳ 還沒出拳"}\n` +
          `<@${b}>：${st.players[b] ? "✅ 已出拳" : "⏳ 還沒出拳"}\n` +
          `（兩位都出拳後自動結算）`;

        await interaction.message.edit({ content, components: rpsComponents(false) });
        return;
      }

      const res = rpsWinner(st.players[a], st.players[b]);
      st.done = true;

      const resultLine =
        res === 0
          ? "🤝 平手！"
          : res === 1
          ? `🎉 <@${a}> 贏了！`
          : `🎉 <@${b}> 贏了！`;

      const content =
        `🪨📄✂️ **猜拳結算**\n` +
        `<@${a}>：${RPS_LABEL[st.players[a]]}\n` +
        `<@${b}>：${RPS_LABEL[st.players[b]]}\n\n` +
        resultLine;

      await interaction.message.edit({ content, components: rpsComponents(true) });
      return;
    }

    return;
  }

  // ---- BJ ----
  if (customId.startsWith("bj:")) {
    let st = bjGames.get(messageId);
    if (!st) {
      // 初始化一局（用按的人當玩家）
      const deck = makeDeck();
      const playerHand = [deck.pop(), deck.pop()];
      const dealerHand = [deck.pop(), deck.pop()];

      st = {
        channelId: interaction.channelId,
        playerId: interaction.user.id,
        opponentId: null,
        deck,
        playerHand,
        dealerHand,
        done: false,
      };
      bjGames.set(messageId, st);

      // 一開始就把牌面渲染（直接開始）
      await interaction.message.edit({
        content: bjRender(st),
        components: bjComponents(false),
      });
    }

    if (st.done) return;

    // 限制只有玩家能按（避免別人亂點）
    if (interaction.user.id !== st.playerId) {
      // 不要 reply，避免打擾，只做小提示（改成不動也行）
      return;
    }

    const action = customId.split(":")[1];

    if (action === "hit") {
      st.playerHand.push(st.deck.pop());
      const pv = handValue(st.playerHand);

      if (pv > 21) {
        st.done = true;
        await interaction.message.edit({
          content: bjRender(st) + "\n\n💥 爆掉了！你輸了 😵",
          components: bjComponents(true),
        });
        return;
      }

      await interaction.message.edit({
        content: bjRender(st),
        components: bjComponents(false),
      });
      return;
    }

    if (action === "stand") {
      // 莊家補牌到 17+
      while (handValue(st.dealerHand) < 17) {
        st.dealerHand.push(st.deck.pop());
      }

      st.done = true;

      const pv = handValue(st.playerHand);
      const dv = handValue(st.dealerHand);

      let result = "";
      if (dv > 21) result = "🎉 莊家爆了！你贏了！";
      else if (pv > dv) result = "🎉 你贏了！";
      else if (pv < dv) result = "😵 你輸了！";
      else result = "🤝 平手！";

      await interaction.message.edit({
        content: bjRender(st) + `\n\n${result}`,
        components: bjComponents(true),
      });
      return;
    }
  }
}

// -------------------- messageCreate（保留你原本 counting/guess 用）--------------------
async function onMessage(message) {
  // 你原本的 counting/guess 文字輸入邏輯如果在別的 games.js 內
  // 這裡先留空避免報錯
}

// -------------------- exports --------------------
const games = {
  rpsStart,
  bjStart,
};

module.exports = {
  games,
  onMessage,
  onInteraction,
};