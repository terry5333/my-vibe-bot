const { Client, GatewayIntentBits, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ApplicationCommandOptionType, EmbedBuilder } = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 10000);

// --- 1. Firebase 初始化 ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://my-pos-4eeee-default-rtdb.firebaseio.com/"
        });
    }
} catch (e) { console.error("Firebase 啟動錯誤:", e); }

const db = admin.database();
const pointsRef = db.ref("userPoints");

// --- 2. 快取系統 (核心：解決讀取緩慢) ---
let topPlayersCache = "暫無資料";
async function updateRankCache() {
    try {
        const snapshot = await pointsRef.once("value");
        const data = snapshot.val() || {};
        const sorted = Object.entries(data).sort(([, a], [, b]) => b - a).slice(0, 10);
        topPlayersCache = sorted.map(([id, p], i) => {
            const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🔹";
            return `${medal} 第 ${i + 1} 名 | <@${id}> \n ╰── 積分：**${p}**`;
        }).join('\n\n') || "目前尚無玩家記錄";
        console.log("🔄 排行榜快取已更新");
    } catch (e) { console.error("快取更新失敗:", e); }
}
// 每 60 秒自動更新一次快取
setInterval(updateRankCache, 60000);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

// --- 3. 指令設定 ---
const commands = [
    { name: 'rank', description: '直接顯示積分排行榜' },
    { name: 'points', description: '我的積分' },
    { name: 'setup-role', description: '身分組按鈕', options: [{ name: 'role', description: '選擇身分組', type: ApplicationCommandOptionType.Role, required: true }], default_member_permissions: PermissionFlagsBits.Administrator.toString() },
    { name: 'guess', description: '開始終極密碼' },
    { name: 'hl', description: '開始高低牌' }
];

client.on('ready', async () => {
    console.log(`✅ ${client.user.tag} 已就緒`);
    updateRankCache(); // 啟動時先抓一次
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
});

// 積分處理
async function addPoints(userId, amount) {
    const userRef = pointsRef.child(userId);
    const snapshot = await userRef.once("value");
    await userRef.set((snapshot.val() || 0) + amount);
}

let game = { guess: { active: false, answer: 0 }, hl: { active: false, lastCard: 0 } };

// --- 4. 交互邏輯 (重點：秒回) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'rank') {
            const embed = new EmbedBuilder()
                .setTitle('🏆 Vibe 全服積分排行榜')
                .setColor(0xFFD700)
                .setDescription(topPlayersCache)
                .setFooter({ text: '排行榜每分鐘自動更新一次' })
                .setTimestamp();
            
            return interaction.reply({ embeds: [embed] }); // 這裡直接回覆快取，反應速度 0.1 秒
        }

        if (interaction.commandName === 'points') {
            await interaction.deferReply({ ephemeral: true });
            const snapshot = await pointsRef.child(interaction.user.id).once("value");
            return interaction.editReply(`💰 你當前的積分：**${snapshot.val() || 0}**`);
        }

        if (interaction.commandName === 'setup-role') {
            const role = interaction.options.getRole('role');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`role_${role.id}`).setLabel(`領取/移除 ${role.name}`).setStyle(ButtonStyle.Primary)
            );
            return interaction.reply({ content: `🎭 **身分組中心**\n點擊下方按鈕來管理身分組：`, components: [row] });
        }

        if (interaction.commandName === 'guess') {
            game.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1 };
            return interaction.reply("🎲 **終極密碼開始！** 請直接輸入 1~100 的數字。");
        }

        if (interaction.commandName === 'hl') {
            game.hl.active = true;
            game.hl.lastCard = Math.floor(Math.random() * 13) + 1;
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('hl_h').setLabel('更大').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('hl_l').setLabel('更小').setStyle(ButtonStyle.Danger)
            );
            return interaction.reply({ content: `🃏 當前點數：**${game.hl.lastCard}**，下一張會更...？`, components: [row] });
        }
    }

    // 按鈕邏輯 (身分組 + 高低牌)
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('role_')) {
            const roleId = interaction.customId.split('_')[1];
            const role = interaction.guild.roles.cache.get(roleId);
            if (!role) return interaction.reply({ content: "找不到身分組", ephemeral: true });
            try {
                if (interaction.member.roles.cache.has(roleId)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: `✅ 已移除 ${role.name}`, ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: `✅ 已領取 ${role.name}`, ephemeral: true });
                }
            } catch (e) { await interaction.reply({ content: "❌ 請檢查機器人權限排名！", ephemeral: true }); }
        }

        if (interaction.customId.startsWith('hl_')) {
            if (!game.hl.active) return interaction.reply({ content: "遊戲已結束", ephemeral: true });
            const next = Math.floor(Math.random() * 13) + 1;
            const win = (interaction.customId === 'hl_h' && next >= game.hl.lastCard) || (interaction.customId === 'hl_l' && next <= game.hl.lastCard);
            if (win) {
                addPoints(interaction.user.id, 5);
                game.hl.lastCard = next;
                await interaction.update({ content: `✅ 猜對了！(+5分) 下一張：**${next}**` });
            } else {
                game.hl.active = false;
                await interaction.update({ content: `❌ 猜錯了！是 **${next}**。`, components: [] });
            }
        }
    }
});

// 文字遊戲邏輯
client.on('messageCreate', async msg => {
    if (msg.author.bot || !game.guess.active) return;
    const num = parseInt(msg.content);
    if (!isNaN(num) && num === game.guess.answer) {
        game.guess.active = false;
        await addPoints(msg.author.id, 50);
        await msg.reply(`🎊 **BINGO！** 答案是 **${num}**，獲得 50 積分！`);
    }
});

client.login(process.env.DISCORD_TOKEN);
