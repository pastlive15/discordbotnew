// commands/slot.js
// Balanced Slot: 4 reels, richer symbol set, proper losing outcomes.
// - Atomic UPDATE with WHERE money >= bet RETURNING
// - "all" supported
// - Profit multiplier applies to PROFIT only (not losses), same policy as before.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');

const COLORS = { GREEN: 0x22c55e, RED: 0xef4444, GOLD: 0xf59e0b };

// Keep your custom guild emojis first, then safe Unicode fallbacks.
const SYMBOLS = [
  '<:DP_slots_eggplant93:1392958941381791924>',
  '<:dp_slots_hearts33:1392958885379444746>',
  '<:DP_slots_cherry:1392959017281654784>',
  '🍋', '🍉', '🍇', '⭐', '🔔', '7️⃣'
]; // >= 6 symbols so "no match" is possible on 4 reels

const REELS = 4;
const REEL_DELAY_MS = 550;
const SPIN_EMOJI = '<a:DP_slots_spin28:1392958778692997190>' || '🔄';

// New balanced payouts
// - 4-kind: big jackpot
// - 3-kind: solid win
// - two_pairs: decent win
// - one_pair: small loss (house edge)
// - none: full loss
const PAYOUTS = Object.freeze({
  four_kind: 10.0,   // x10
  three_kind: 3.0,   // x3
  two_pairs: 2.0,    // x2
  one_pair: 0.5,     // x0.5 (lose half)
  none: 0.0,         // x0
});

// Soften pure jackpot spikes (re-roll 80% if 4OAK)
const JACKPOT_REROLL_P = 0.80;

const fmt = (n) => new Intl.NumberFormat().format(Math.max(0, Number(n || 0)));

function rollOnce() {
  return Array.from({ length: REELS }, () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]);
}

function classify(result) {
  // count frequencies
  const count = {};
  for (const s of result) count[s] = (count[s] || 0) + 1;
  const freqs = Object.values(count).sort((a, b) => b - a); // e.g., [2,2] or [3,1] or [1,1,1,1]
  if (freqs[0] === 4) return 'four_kind';
  if (freqs[0] === 3) return 'three_kind';
  if (freqs[0] === 2) {
    const pairs = freqs.filter(v => v === 2).length;
    if (pairs === 2) return 'two_pairs';
    return 'one_pair';
  }
  return 'none';
}

function rollResult() {
  let r, hand;
  do {
    r = rollOnce();
    hand = classify(r);
    if (hand === 'four_kind' && Math.random() < JACKPOT_REROLL_P) continue;
    break;
  } while (true);
  return { result: r, hand };
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
    // NOTE: make sure initUser takes (user, db) like your other modules
    const user = await initUser(interaction.user, db); // was initUser(interaction.user) before
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

    // Animated spin (message then edit)
    const spinningRow = Array(REELS).fill(SPIN_EMOJI);
    await interaction.reply({
      content: `🎰 Spinning...\n${spinningRow.join(' | ')}`,
      fetchReply: true,
    });

    const { result, hand } = rollResult();

    // Reveal reels one-by-one
    const display = [...spinningRow];
    for (let i = 0; i < REELS; i++) {
      await new Promise(r => setTimeout(r, REEL_DELAY_MS));
      display[i] = result[i];
      await interaction.editReply({ content: `🎰 Spinning...\n${display.join(' | ')}` });
    }

    // Compute payout with new table; profit-only multiplier
    const multiplier = PAYOUTS[hand] ?? 0;
    const rawReturn = bet * multiplier;
    const totalBase = Math.floor(rawReturn);
    const isWin = totalBase > bet;

    const profit = isWin ? Math.floor((totalBase - bet) * coinMult) : 0;
    const winnings = isWin ? (bet + profit) : totalBase;
    const outcomeStr =
      isWin
        ? `🎉 You won **${fmt(winnings - bet)}** coins profit! (${hand.replace('_', ' ')} · base x${multiplier.toFixed(1)}, profit×${coinMult.toFixed(2)})`
        : winnings === bet
          ? `😐 Break-even. (${hand.replace('_', ' ')})`
          : `😢 You lost **${fmt(bet - winnings)}** coins. (${hand.replace('_', ' ')})`;

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
      const warn = new EmbedBuilder()
        .setColor(COLORS.RED)
        .setTitle('Balance Changed')
        .setDescription('⚠️ Your balance changed during the spin. The bet was not deducted. Try again.')
        .setTimestamp();
      return interaction.editReply({ content: '', embeds: [warn] });
    }

    const newBalance = Number(rows[0].money || 0);

    const embed = new EmbedBuilder()
      .setTitle('🎰 Slot Machine Result')
      .setColor(winnings > bet ? COLORS.GREEN : winnings === bet ? COLORS.GOLD : COLORS.RED)
      .setDescription(
        `🎲 **Result:**\n${result.join(' | ')}\n\n` +
        `💰 **Bet:** ${fmt(bet)}\n` +
        `🎁 **Return:** ${fmt(winnings)}\n` +
        `${outcomeStr}\n\n` +
        `<a:PixelCoin:1392196932926967858> **Balance:** ${fmt(newBalance)}`
      )
      .setFooter({ text: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ forceStatic: false }) })
      .setTimestamp();

    return interaction.editReply({ content: '', embeds: [embed] });
  },
};
