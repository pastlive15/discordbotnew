// commands/gamble.js
// PostgreSQL-compatible Gamble Command (atomic, supports "bet all")
// - Atomic balance update with UPDATE ... WHERE money >= bet RETURNING
// - "all" bets your current wallet safely
// - Coin multiplier affects PROFIT on win (lose = -bet)
// - Pretty embeds + comma formatting

const { EmbedBuilder, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');

const COLORS = { GREEN: 0x22c55e, RED: 0xef4444, BLURPLE: 0x5865F2 };
const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));

module.exports = {
  name: 'gamble',
  description: 'Gamble your coins for a chance to double or lose them',
  data: new SlashCommandBuilder()
    .setName('gamble')
    .setDescription('Gamble your coins for a chance to double or lose them')
    .addStringOption(option =>
      option.setName('bet')
        .setDescription('Amount of coins to bet (number or "all")')
        .setRequired(true)
    ),

  async execute(interaction, db) {
    const user = await initUser(interaction.user);
    if (!user) {
      return interaction.reply({
        content: '❌ You need a profile to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const rawBet = interaction.options.getString('bet').trim().toLowerCase();
    const wallet = Number(user.money || 0);

    // parse bet ("all" or integer)
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

    // quick local check first
    if (wallet < bet) {
      return interaction.reply({
        content: `🚫 You don’t have enough coins. Balance: **${fmt(wallet)}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // outcome
    const winChance = 0.5;
    const win = Math.random() < winChance;
    const coinMult = Number(user.coin_multiplier ?? 1.0);
    const profitOnWin = Math.floor(bet * coinMult); // profit (not total payout)

    // delta to apply atomically
    const delta = win ? profitOnWin : -bet;

    // Atomic update: ensure funds are still sufficient at commit time
    const { rows, rowCount } = await db.query(
      `UPDATE users
         SET money = money + $1
       WHERE user_id = $2
         AND money >= $3
       RETURNING money`,
      [delta, interaction.user.id, bet]
    );

    if (rowCount === 0) {
      // Someone (or another command) changed the balance meanwhile
      const snap = await db.query('SELECT money FROM users WHERE user_id = $1', [interaction.user.id]);
      const current = Number(snap.rows[0]?.money || 0);
      return interaction.reply({
        content: `⚠️ Your balance changed while processing. Current balance: **${fmt(current)}**. Try again.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const newBalance = Number(rows[0].money || 0);

    const embed = new EmbedBuilder()
      .setTitle('🎲 Gamble Result')
      .setColor(win ? COLORS.GREEN : COLORS.RED)
      .setDescription(
        win
          ? `🎉 You **won** **${fmt(profitOnWin)}** coins!\n<a:PixelCoin:1392196932926967858> New Balance: **${fmt(newBalance)}**`
          : `😢 You **lost** **${fmt(bet)}** coins.\n<a:PixelCoin:1392196932926967858> New Balance: **${fmt(newBalance)}**`
      )
      .setFooter({ text: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ forceStatic: false }) })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
