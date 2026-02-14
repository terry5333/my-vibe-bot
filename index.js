const { 
    Client, GatewayIntentBits, REST, Routes, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, 
    PermissionFlagsBits, ApplicationCommandOptionType, EmbedBuilder 
} = require('discord.js');
const express = require('express');
const admin = require('firebase-admin');

// --- 1. Firebase 初始化 ---
// 請確保 Render 的 FIREBASE_CONFIG 環境變數是完整的 JSON 字串
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com/`
    });
    console.log("🔥 Firebase 連線成功！");
} catch (e) {
    console.error("❌ Firebase 初始化失敗，請檢查 FIREBASE_CONFIG 變數:", e);
}

const db = admin.database();
const pointsRef = db.ref("userPoints");

// --- 2. Web Server (Render 存活專用) ---
const app = express();
app.get('/', (req, res) => res.send('Vibe Bot + Firebase is Online! 🚀'));
app.listen(process.env.PORT || 10000);

// --- 3. 初始化 Client ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers 
    ]
});

// 積分非同步處理函式
async function addPoints(userId, amount) {
    const userRef = pointsRef.child(userId);
    const snapshot = await userRef.once("value");
    const currentPoints = snapshot.val() || 0;
    await userRef.set(currentPoints + amount);
}

// --- 4. 指令清單 ---
const commands = [
    {
        name: 'setup-role',
        description: '發送身分組領取按鈕 (管理員用)',
        options: [{ name: 'target-role', description: '請選擇身分組', type: ApplicationCommandOptionType.Role, required: true }],
        default_member_permissions: PermissionFlagsBits.Administrator.toString()
    },
    { name: 'rank', description: '查看積分排行榜' },
    { name: 'points', description: '查看我的個人積分' },
    { name: 'counting', description: '開始數數接力遊戲' },
    { name: 'guess', description: '開始終極密碼 (1-100)' },
    { name: 'hl', description: '開始高低牌遊戲' },
    { name: 'stop', description: '停止所有進行中的遊戲' },
    { name: 'vibe', description: '檢查系統狀態' }
];

let gameData = {
    counting: { active: false, current: 0, lastUser: null },
    guess: { active: false, answer: 0, min: 1, max: 100 },
    hl: { active: false, lastCard: 0 }
};

client.on('ready', async () => {
    console.log(`🤖 機器人已上線：${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('✅ 所有指令已註冊成功');
    } catch (e) { console.error(e); }
});

// --- 5. 互動處理 ---
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // 排行榜 (使用 deferReply 防止逾時)
        if (commandName === 'rank') {
            await interaction.deferReply();
            const snapshot = await pointsRef.once("value");
            const data = snapshot.val() || {};
            const sorted = Object.entries(data).sort(([, a], [, b]) => b - a).slice(0, 10);
            const description = sorted.map(([id, pts], i) => `${i + 1}. <@${id}> - **${pts}** 分`).join('\n') || "目前尚無積分記錄";
            
            const embed = new EmbedBuilder().setTitle('🏆 積分排行榜').setDescription(description).setColor(0xFFD700);
            return await interaction.editReply({ embeds: [embed] });
        }

        // 個人分數
        if (commandName === 'points') {
            await interaction.deferReply({ ephemeral: true });
            const snapshot = await pointsRef.child(interaction.user.id).once("value");
            const pts = snapshot.val() || 0;
            return await interaction.editReply(`💰 你目前擁有 **${pts}** 分！`);
        }

        // 身分組按鈕
        if (commandName === 'setup-role') {
            const role = interaction.options.getRole('target-role');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`tg_${role.id}`).setLabel(`領取 / 移除 ${role.name}`).setStyle(ButtonStyle.Primary).setEmoji('✨')
            );
            return await interaction.reply({ content: `🎭 **身分組中心**\n點擊下方按鈕管理你的 **${role.name}** 身分組：`, components: [row] });
        }

        // 遊戲啟動邏輯
        if (commandName === 'counting') {
            gameData.counting = { active: true, current: 0, lastUser: null };
            await interaction.reply('🎮 **數數接力開始！** 請從 **1** 開始輸入。');
        }
        if (commandName === 'guess') {
            gameData.guess = { active: true, answer: Math.floor(Math.random() * 100) + 1, min: 1, max: 100 };
            await interaction.reply('🎲 **終極密碼開始！** 範圍：1 ~ 100。');
        }
        if (commandName === 'hl') {
            gameData.hl.active = true;
            gameData.hl.lastCard = Math.floor(Math.random() * 13) + 1;
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('hl_h').setLabel('大').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('hl_l').setLabel('小').setStyle(ButtonStyle.Danger)
            );
            await interaction.reply({ content: `🃏 **高低牌** | 當前數字：**${gameData.hl.lastCard}**\n猜猜下一張牌會更大還是更小？`, components: [row] });
        }
        if (commandName === 'stop') {
            gameData.counting.active = gameData.guess.active = gameData.hl.active = false;
            await interaction.reply('🛑 所有遊戲已關閉。');
        }
        if (commandName === 'vibe') await interaction.reply('⚡ 系統運作正常！');
    }

    // 按鈕處理
    if (interaction.isButton()) {
        // 身分組切換
        if (interaction.customId.startsWith('tg_')) {
            const roleId = interaction.customId.replace('tg_', '');
            const role = interaction.guild.roles.cache.get(roleId);
            if (!role) return await interaction.reply({ content: '❌ 找不到該身分組', ephemeral: true });
            
            try {
                if (interaction.member.roles.cache.has(role.id)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: `👋 已為你移除 **${role.name}**。`, ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: `✅ 已為你新增 **${role.name}**！`, ephemeral: true });
                }
            } catch (err) {
                await interaction.reply({ content: '❌ 權限錯誤，請將機器人身分組拉到最高！', ephemeral: true });
            }
        }

        // 高低牌互動
        if (interaction.customId.startsWith('hl_')) {
            if (!gameData.hl.active) return await interaction.reply({ content: '遊戲已結束。', ephemeral: true });
            const next = Math.floor(Math.random() * 13) + 1;
            const win = (interaction.customId === 'hl_h' && next >= gameData.hl.lastCard) || (interaction.customId === 'hl_l' && next <= gameData.hl.lastCard);
            
            if (win) {
                await addPoints(interaction.user.id, 5);
                gameData.hl.lastCard = next;
                await interaction.update({ content: `✅ 猜對了！(+5分) 下一張：**${next}**`, components: [interaction.message.components[0]] });
            } else {
                gameData.hl.active = false;
                await interaction.update({ content: `💥 猜錯了！是 **${next}**。遊戲結束！`, components: [] });
            }
        }
    }
});

// --- 6. 訊息監聽 (數數 & 密碼) ---
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    if (gameData.counting.active) {
        const num = parseInt(msg.content);
        if (num === gameData.counting.current + 1 && msg.author.id !== gameData.counting.lastUser) {
            gameData.counting.current++;
            gameData.counting.lastUser = msg.author.id;
            await addPoints(msg.author.id, 1);
            await msg.react('✅');
        } else if (!isNaN(num)) {
            gameData.counting.active = false;
            await msg.reply(`❌ 數錯了！<@${msg.author.id}> 斷了連鎖。遊戲重置！`);
        }
    }

    if (gameData.guess.active) {
        const num = parseInt(msg.content);
        if (num === gameData.guess.answer) {
            await addPoints(msg.author.id, 50);
            await msg.reply(`🎊 BINGO！<@${msg.author.id}> 猜中了 **${gameData.guess.answer}**，獲得 50 積分！`);
            gameData.guess.active = false;
        } else if (num > gameData.guess.min && num < gameData.guess.max) {
            if (num < gameData.guess.answer) gameData.guess.min = num;
            else gameData.guess.max = num;
            await msg.reply(`📉 新範圍：**${gameData.guess.min} ~ ${gameData.guess.max}**`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
