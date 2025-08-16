// commands/slot.js
// PostgreSQL-compatible Slot Command (4-reel, "bet all", atomic balance update)
// - Atomic UPDATE ... WHERE money >= bet RETURNING
// - "all" uses current wallet; blocks if wallet is 0
// - Coin multiplier applies to PROFIT only (not to losses), consistent with spinwheel
// - Simple anti-jackpot re-roll (95% re-roll chance if 4-of-a-kind)

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');

const COLORS = { GREEN: 0x22c55e, RED: 0xef4444, GOLD: 0xf59e0b };
const SYMBOLS = [
  '<:DP_slots_eggplant93:1392958941381791924>',
  '<:dp_slots_hearts33:1392958885379444746>',
  '<:DP_slots_cherry:1392959017281654784>',
];
const REELS = 4;
const REEL_DELAY_MS = 550;
const SPIN_EMOJI = '<a:DP_slots_spin28:1392958778692997190>';

const PAYOUTS = {
  4: 5.0,   // 4 of a kind → x5
  3: 2.0,   // 3 of a kind → x2
  2: 1.2,   // any pair    → x1.2
  1: 0.0,   // none        → x0 (lose full bet)
};

const fmt = (n) => new Intl.NumberFormat().format(Math.max(0, Number(n || 0)));

function rollResult() {
  let result;
  do {
    result = Array.from({ length: REELS }, () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]);
    if (result.every(v => v === result[0]) && Math.random() < 0.95) continue; // soften 4OAK
    break;
  } while (true);
  return result;
}

function maxOfAKind(result) {
  const count = {};
  for (const s of result) count[s] = (count[s] || 0) + 1;
  return Math.max(...Object.values(count));
}

module.exports = {
  name: 'slot',
  description: 'Spin a slot machine and try your luck!',
  data: new SlashCommandBuilder()
    .setName('slot')
    .setDescription('Play the slot machine')
    .addStringOption(option =>
      option.setName('bet')
        .setDescription('How much do you want to bet? (number or "all")')
        .setRequired(true)
    ),

  async execute(interaction, db) {
    const user = await initUser(interaction.user);
    if (!user) {
      return interaction.reply({ content: '❌ You need a profile to play.', flags: MessageFlags.Ephemeral });
    }

    const wallet = Number(user.money || 0);
    const coinMult = Number(user.coin_multiplier ?? 1.0);

    const betInput = (interaction.options.getString('bet') || '').trim().toLowerCase();
    let bet;
    if (betInput === 'all') {
      bet = wallet;
    } else if (/^\d+$/.test(betInput.replace(/,/g, ''))) {
      bet = Math.floor(Number(betInput.replace(/,/g, '')));
    } else {
      bet = NaN;
    }

    if (!Number.isFinite(bet) || bet <= 0) {
      return interaction.reply({
        content: '❌ Your bet must be a whole number greater than 0, or "all".',
        flags: MessageFlags.Ephemeral
      });
    }

    if (wallet <= 0) {
      return interaction.reply({ content: '💸 Your wallet is empty.', flags: MessageFlags.Ephemeral });
    }

    if (wallet < bet) {
      return interaction.reply({ content: `💸 You don’t have enough coins. Balance: **${fmt(wallet)}**`, flags: MessageFlags.Ephemeral });
    }

    // Animated spin (plain message first, then edit)
    const spinningRow = Array(REELS).fill(SPIN_EMOJI);
    const replyMsg = await interaction.reply({
      content: `🎰 Spinning...\n${spinningRow.join(' | ')}`,
      fetchReply: true,
    });

    const result = rollResult();

    // Reveal reels one by one
    const display = [...spinningRow];
    for (let i = 0; i < REELS; i++) {
      await new Promise(r => setTimeout(r, REEL_DELAY_MS));
      display[i] = result[i];
      await interaction.editReply({ content: `🎰 Spinning...\n${display.join(' | ')}` });
    }

    // Compute payout → apply coin multiplier to profits only
    const ofAKind = maxOfAKind(result);
    const multiplier = PAYOUTS[ofAKind] ?? 0;
    const rawPayout = bet * multiplier;
    const baseWin = Math.floor(rawPayout);              // total back before multiplier logic
    const isWin = baseWin > bet;

    // Profit only portion
    const profit = isWin ? Math.floor((baseWin - bet) * coinMult) : 0;
    const winnings = isWin ? (bet + profit) : baseWin; // total credited this spin
    const netChange = winnings - bet;

    // Atomic balance update
    const { rows, rowCount } = await db.query(
      `
      UPDATE users
      SET money = money - $2 + $3
      WHERE user_id = $1
        AND money >= $2
      RETURNING money
      `,
      [interaction.user.id, bet, winnings]
    );

    if (rowCount === 0) {
      // Balance changed mid-spin; bet not deducted
      const warn = new EmbedBuilder()
        .setColor(COLORS.RED)
        .setTitle('Balance Changed')
        .setDescription('⚠️ Your balance changed during the spin. The bet was not deducted. Try again.')
        .setTimestamp();
      return interaction.editReply({ content: '', embeds: [warn] });
    }

    const newBalance = Number(rows[0].money || 0);

    const outcome =
      winnings > bet
        ? `🎉 You won **${fmt(winnings - bet)}** coins profit! (x${multiplier.toFixed(1)} base, profit×${coinMult.toFixed(2)})`
        : winnings === bet
          ? `😐 Break-even.`
          : `😢 You lost **${fmt(bet - winnings)}** coins.`;

    const embed = new EmbedBuilder()
      .setTitle('🎰 Slot Machine Result')
      .setColor(winnings > bet ? COLORS.GREEN : winnings === bet ? COLORS.GOLD : COLORS.RED)
      .setDescription(
        `🎲 **Result:**\n${result.join(' | ')}\n\n` +
        `💰 **Bet:** ${fmt(bet)}\n` +
        `🎁 **Return:** ${fmt(winnings)}\n` +
        `${outcome}\n\n` +
        `<a:PixelCoin:1392196932926967858> **Balance:** ${fmt(newBalance)}`
      )
      .setFooter({ text: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ forceStatic: false }) })
      .setTimestamp();

    return interaction.editReply({ content: '', embeds: [embed] });
  },
};
