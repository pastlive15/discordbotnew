// commands/slot.js
// Balanced Slot (v2): easier win rate a bit + new payouts.
// - 4 reels, richer symbols, proper losing outcomes.
// - Slight "repeat bias" to increase pairs/triples a little.
// - Atomic UPDATE; "all" bet supported; profit multiplier applies to profit only.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');

const COLORS = { GREEN: 0x22c55e, RED: 0xef4444, GOLD: 0xf59e0b };

// >= 6–7 symbols so "no match" still possible on 4 reels
const SYMBOLS = [
  '👑',
  '⚜️',
  '🍀',
  '🍋', '🍉', '🍇', '⭐', '🔔', '7️⃣'
];

const REELS = 4;
const REEL_DELAY_MS = 550;
const SPIN_EMOJI = '<a:DP_slots_spin28:1392958778692997190>' || '🔄';

// Friendlier payouts from previous step
const PAYOUTS = Object.freeze({
  four_kind: 12.0,
  three_kind: 4.0,
  two_pairs: 2.5,
  one_pair: 0.8, // still a small loss
  none: 0.0,
});

// Jackpots a bit easier than before (kept)
const JACKPOT_REROLL_P = 0.50;

// --- New tuning knobs to cut "one pair" frequency ---
const REPEAT_BIAS = 0.06; // was 0.10 -> lower chance to copy previous symbols
// If the current pick would create the FIRST pair of the spin (no pair existed yet),
// we veto it with these probabilities per reel index (1-based thinking: reels 2..4).
// High veto at reel 2 (strong cut of single-pair), milder at reel 3..4 to preserve 3-kind/two-pairs.
const SINGLE_PAIR_VETO = [0.00, 0.60, 0.35, 0.20]; // index by i (0..3), used for i>0

const fmt = (n) => new Intl.NumberFormat().format(Math.max(0, Number(n || 0)));

function randomSymbol(exclude = null) {
  if (!exclude || exclude.size === 0 || exclude.size >= SYMBOLS.length) {
    return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  }
  // pick a symbol not in exclude (try a few times; fallback to any)
  const pool = SYMBOLS.filter(s => !exclude.has(s));
  if (pool.length === 0) return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  return pool[Math.floor(Math.random() * pool.length)];
}

function classify(result) {
  const count = {};
  for (const s of result) count[s] = (count[s] || 0) + 1;
  const freqs = Object.values(count).sort((a, b) => b - a);
  if (freqs[0] === 4) return 'four_kind';
  if (freqs[0] === 3) return 'three_kind';
  if (freqs[0] === 2) {
    const pairs = freqs.filter(v => v === 2).length;
    if (pairs === 2) return 'two_pairs';
    return 'one_pair';
  }
  return 'none';
}

function aboutToCreateFirstPair(currentSymbols, candidate) {
  if (currentSymbols.length === 0) return false;
  // Count existing
  const count = {};
  for (const s of currentSymbols) count[s] = (count[s] || 0) + 1;
  const hasPairAlready = Object.values(count).some(v => v >= 2);
  if (hasPairAlready) return false; // not the *first* pair

  // Would candidate match any existing symbol and make a pair?
  return currentSymbols.includes(candidate);
}

function rollOnce() {
  const result = [];
  for (let i = 0; i < REELS; i++) {
    // default candidate: repeat bias or fresh draw
    let candidate;
    if (i > 0 && Math.random() < REPEAT_BIAS) {
      const j = Math.floor(Math.random() * i);
      candidate = result[j];
    } else {
      candidate = randomSymbol();
    }

    // If this would create the *first* pair, veto with probability SINGLE_PAIR_VETO[i]
    if (i > 0 && aboutToCreateFirstPair(result, candidate)) {
      const vetoP = SINGLE_PAIR_VETO[i] || 0;
      if (Math.random() < vetoP) {
        // try to pick a symbol that doesn't appear yet (avoid making that first pair)
        const exclude = new Set(result); // avoid *any* seen so far
        candidate = randomSymbol(exclude);
      }
    }

    result.push(candidate);
  }
  return result;
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
    const user = await initUser(interaction.user, db);
    if (!user) {
      return interaction.reply({ content: '❌ You need a profile to play.', flags: MessageFlags.Ephemeral });
    }

    const wallet = Number(user.money || 0);
    const coinMult = Number(user.coin_multiplier ?? 1.0);

    const betInput = (interaction.options.getString('bet') || '').trim().toLowerCase();
    let bet;
    if (betInput === 'all') bet = wallet;
    else if (/^\d+$/.test(betInput.replace(/,/g, ''))) bet = Math.floor(Number(betInput.replace(/,/g, '')));
    else bet = NaN;

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

    // Animated spin
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

    // Payout (profit-only multiplier)
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