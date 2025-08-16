// commands/spinwheel.js
// PostgreSQL-compatible Spin Wheel (atomic, supports "bet all")
// - Atomic balance change with UPDATE ... WHERE money >= bet RETURNING
// - "all" safely uses current wallet
// - Coin multiplier applies to PROFITS only (not to losses)
// - Pretty number formatting

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');

const COLORS = { RED: 0xef4444, GREEN: 0x22c55e, GOLD: 0xf59e0b, BLUE: 0x3b82f6 };
const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));

module.exports = {
  name: 'spinwheel',
  description: 'Spin a colorful wheel for a chance to win coins!',
  data: new SlashCommandBuilder()
    .setName('spinwheel')
    .setDescription('Spin the wheel and test your luck!')
    .addStringOption(option =>
      option.setName('bet')
        .setDescription('The amount of coins you want to bet (number or "all")')
        .setRequired(true)
    ),

  async execute(interaction, db) {
    // สร้างโปรไฟล์ถ้ายังไม่มี
    const user = await initUser(interaction.user);
    if (!user) {
      return interaction.reply({
        content: '❌ You need a profile to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const rawBet = interaction.options.getString('bet').trim().toLowerCase();
    const wallet = Number(user.money || 0);

    // แปลงจำนวนเดิมพัน
    let bet = 0;
    if (rawBet === 'all') {
      bet = wallet;
    } else if (/^\d+$/.test(rawBet)) {
      bet = parseInt(rawBet, 10);
    }

    if (!Number.isFinite(bet) || bet <= 0) {
      return interaction.reply({
        content: '❌ Invalid bet. Enter a whole number or use `all`.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (wallet < bet) {
      return interaction.reply({
        content: `🚫 You don’t have enough coins. Balance: **${fmt(wallet)}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // ตารางช่องล้อ (ตั้งน้ำหนักแจ็คพ็อตต่ำ)
    const segments = [
      { emoji: '💰', label: 'x2.0', multiplier: 2.0 },
      { emoji: '🍀', label: 'x1.5', multiplier: 1.5 },
      { emoji: '🪙', label: 'x1.2', multiplier: 1.2 },
      { emoji: '😐', label: 'x0.5', multiplier: 0.5 },
      { emoji: '❌', label: 'Lose', multiplier: 0.0 },
      { emoji: '🎉', label: 'Jackpot!', multiplier: 5.0, rare: true },
    ];

    // สุ่มผลลัพธ์: โอกาส jackpot ~3%, นอกนั้นเลือกจากที่เหลือแบบสม่ำเสมอ
    const spin = () => {
      if (Math.random() < 0.03) return segments.find(s => s.rare);
      const pool = segments.filter(s => !s.rare);
      return pool[Math.floor(Math.random() * pool.length)];
    };

    const result = spin();

    // คำนวณเงินออก/เข้า
    // - payout = bet * multiplier
    // - กรณีชนะ (payout > bet): กำไร = (payout - bet) * coin_multiplier
    // - กรณีแพ้ (payout < bet): ขาดทุน = bet - payout  (ไม่คูณ multiplier)
    const coinMult = Number(user.coin_multiplier ?? 1.0);
    const payout = Math.floor(bet * result.multiplier);
    const isWin = payout > bet;
    const profit = isWin ? Math.floor((payout - bet) * coinMult) : 0;
    const loss = isWin ? 0 : (bet - payout);
    const delta = profit - loss; // จำนวนที่จะบวก/ลบกับกระเป๋า

    // อัปเดตแบบอะตอมมิก (ป้องกันยอดเปลี่ยน/แข่งกด): ต้องมีอย่างน้อย bet ตอนเริ่มหมุน
    const { rows, rowCount } = await db.query(
      `UPDATE users
         SET money = money + $1
       WHERE user_id = $2
         AND money >= $3
       RETURNING money`,
      [delta, interaction.user.id, bet]
    );

    if (rowCount === 0) {
      // ยอดเปลี่ยนไประหว่างทาง
      const snap = await db.query('SELECT money FROM users WHERE user_id = $1', [interaction.user.id]);
      const curr = Number(snap.rows[0]?.money || 0);
      return interaction.reply({
        content: `⚠️ Your balance changed while spinning. Current balance: **${fmt(curr)}**. Try again.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const newBalance = Number(rows[0].money || 0);
    const wheelVisual = segments.map(seg => seg.emoji).join(' ');
    const netGain = delta;

    const embed = new EmbedBuilder()
      .setTitle('🎡 Spin the Wheel!')
      .setColor(result.multiplier === 0 ? COLORS.RED : result.multiplier >= 2 ? COLORS.GOLD : COLORS.GREEN)
      .setDescription(
        `**${interaction.user.username}** spun the wheel...\n\n` +
        `${wheelVisual}\n` +
        `➡️ **Result:** ${result.emoji} ${result.label}\n\n` +
        `💰 **Bet:** ${fmt(bet)} coins\n` +
        `🎁 **Payout:** ${fmt(payout)} coins\n` +
        (isWin
          ? `✨ **Profit (after multiplier):** ${fmt(profit)} coins\n`
          : `💥 **Loss:** ${fmt(loss)} coins\n`) +
        `\n${netGain >= 0 ? `✅ You won **${fmt(netGain)}** coins!` : `❌ You lost **${fmt(-netGain)}** coins.`}\n\n` +
        `💼 **New Balance:** ${fmt(newBalance)} coins`
      )
      .setFooter({ text: 'Good luck!', iconURL: interaction.user.displayAvatarURL({ forceStatic: false }) })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};
