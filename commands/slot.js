// commands/slot.js
// Slots with 3 special symbols (👑, ⚜️, 🍀) and per-symbol payouts for NORMALS.
// - Picks the SINGLE best multiplier that applies (no stacking).
// - Normal symbols now have different values (e.g., 7️⃣ > 🔔 > ⭐ > 🍇 > 🍉 > 🍋).
// - Reduced single-pair spam (repeat bias + first-pair veto).
// - Profit multiplier applies to PROFIT only. Atomic balance update.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { initUser } = require('../utils/initUser');

const COLORS = { GREEN: 0x22c55e, RED: 0xef4444, GOLD: 0xf59e0b };

const SPECIAL = {
  CROWN: '👑', // rarest, highest payouts
  FLEUR: '⚜️',
  CLOVER: '🍀',
};

// Normal symbols (keep at least 6 to allow losing outcomes with 4 reels)
const NORMALS = ['🍋', '🍉', '🍇', '⭐', '🔔', '7️⃣'];
const SYMBOLS = [SPECIAL.CROWN, SPECIAL.FLEUR, SPECIAL.CLOVER, ...NORMALS];

// Weighted rarity (larger => more common). Specials rarer; normals equal rarity by default.
const WEIGHTS = {
  [SPECIAL.CROWN]: 0.10,
  [SPECIAL.FLEUR]: 0.20,
  [SPECIAL.CLOVER]: 0.30,
  '🍋': 1.0, '🍉': 1.0, '🍇': 1.0, '⭐': 1.0, '🔔': 1.0, '7️⃣': 1.0,
};

const REELS = 4;
const REEL_DELAY_MS = 550;
const SPIN_EMOJI = '<a:DP_slots_spin28:1392958778692997190>' || '🔄';

// ── Base (generic) payouts used when no symbol-specific rule pays better ──
const GENERIC_PAYOUTS = Object.freeze({
  four_kind: 12.0,
  three_kind: 4.0,
  two_pairs: 2.5,
  one_pair: 0.8,  // small loss
  none: 0.0,
});

// ── Special symbol payouts (override if higher) ──
const SPECIAL_PAYOUTS = Object.freeze({
  [SPECIAL.CROWN]: { 2: 3.0, 3: 8.0, 4: 25.0 },
  [SPECIAL.FLEUR]: { 2: 2.0, 3: 5.0, 4: 15.0 },
  [SPECIAL.CLOVER]: { 2: 1.5, 3: 3.5, 4: 10.0 },
});

// ── NEW: Normal symbol payouts (different per symbol). These can be higher *or equal* to generic. ──
// Tip: set low-tier normals equal to generic so they don't underpay; set high-tier normals above generic.
const NORMAL_PAYOUTS = Object.freeze({
  //        2-kind, 3-kind, 4-kind
  '🍋':   { 2: 0.8,  3: 3.5, 4: 12.0 },  // baseline-ish
  '🍉':   { 2: 1.3,  3: 3.8, 4: 12.2 },
  '🍇':   { 2: 1.5,  3: 4.0, 4: 12.5 },
  '⭐':   { 2: 1.0,  3: 4.2, 4: 12.8 },
  '🔔':   { 2: 1.1,  3: 4.5, 4: 13.2 },
  '7️⃣':  { 2: 1.2,  3: 5.0, 4: 14.0 },  // top normal
});

// Slightly easier jackpots than a strict baseline (still can reroll a portion)
const JACKPOT_REROLL_P = 0.50;

// Tuning to reduce only-one-pair frequency
const REPEAT_BIAS = 0.29;                         // chance to copy a previous reel
const SINGLE_PAIR_VETO = [0.00, 0.60, 0.35, 0.20]; // veto first pair on reels 2..4

const fmt = (n) => new Intl.NumberFormat().format(Math.max(0, Number(n || 0)));

// ---------- Weighted random ----------
function weightedPick(candidates) {
  let total = 0;
  for (const s of candidates) total += WEIGHTS[s] ?? 1.0;
  let r = Math.random() * total;
  for (const s of candidates) {
    const w = WEIGHTS[s] ?? 1.0;
    if ((r -= w) <= 0) return s;
  }
  return candidates[candidates.length - 1];
}

function randomSymbol(excludeSet = null) {
  const pool = excludeSet ? SYMBOLS.filter(s => !excludeSet.has(s)) : SYMBOLS.slice();
  if (pool.length === 0) return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  return weightedPick(pool);
}

// ---------- Payout helpers ----------
function classifyCounts(arr) {
  const map = {};
  for (const s of arr) map[s] = (map[s] || 0) + 1;
  return map;
}

function genericHandMultiplier(countMap) {
  const freqs = Object.values(countMap).sort((a, b) => b - a);
  if (freqs[0] === 4) return GENERIC_PAYOUTS.four_kind;
  if (freqs[0] === 3) return GENERIC_PAYOUTS.three_kind;
  if (freqs[0] === 2) {
    const pairs = freqs.filter(v => v === 2).length;
    return pairs === 2 ? GENERIC_PAYOUTS.two_pairs : GENERIC_PAYOUTS.one_pair;
  }
  return GENERIC_PAYOUTS.none;
}

function specialMultiplier(countMap) {
  let best = 0;
  for (const sym of [SPECIAL.CROWN, SPECIAL.FLEUR, SPECIAL.CLOVER]) {
    const k = countMap[sym] || 0;
    if (k >= 2) {
      const table = SPECIAL_PAYOUTS[sym];
      const m = table?.[k] || 0;
      if (m > best) best = m;
    }
  }
  return best;
}

function normalMultiplier(countMap) {
  let best = 0;

  // Consider mono-symbol made of normals (pair/triple/quad)
  for (const sym of NORMALS) {
    const k = countMap[sym] || 0;
    if (k >= 2) {
      const table = NORMAL_PAYOUTS[sym];
      const m = table?.[k] ?? 0;
      if (m > best) best = m;
    }
  }

  // Consider two_pairs case made of normals: evaluate each pair's "2-kind" payout and
  // take the *higher* of the two; compare with generic two_pairs later (in bestMultiplier).
  const pairs = Object.entries(countMap).filter(([_, v]) => v === 2);
  if (pairs.length === 2) {
    const pairVals = pairs.map(([sym]) => {
      if (NORMAL_PAYOUTS[sym]?.[2]) return NORMAL_PAYOUTS[sym][2];
      if (sym === SPECIAL.CROWN || sym === SPECIAL.FLEUR || sym === SPECIAL.CLOVER) {
        return SPECIAL_PAYOUTS[sym]?.[2] ?? 0;
      }
      return 0;
    });
    const bestPairVal = Math.max(...pairVals, 0);
    if (bestPairVal > best) best = bestPairVal;
  }

  return best;
}

function bestMultiplier(result) {
  const counts = classifyCounts(result);
  const g = genericHandMultiplier(counts);
  const s = specialMultiplier(counts);
  const n = normalMultiplier(counts);
  return Math.max(g, s, n);
}

// ---------- Pair-veto logic ----------
function aboutToCreateFirstPair(currentSymbols, candidate) {
  if (currentSymbols.length === 0) return false;
  const count = {};
  for (const s of currentSymbols) count[s] = (count[s] || 0) + 1;
  const hasPairAlready = Object.values(count).some(v => v >= 2);
  if (hasPairAlready) return false;
  return currentSymbols.includes(candidate);
}

// ---------- Roll ----------
function rollOnce() {
  const result = [];
  for (let i = 0; i < REELS; i++) {
    let candidate;
    if (i > 0 && Math.random() < REPEAT_BIAS) {
      const j = Math.floor(Math.random() * i);
      candidate = result[j];
    } else {
      candidate = randomSymbol();
    }

    if (i > 0 && aboutToCreateFirstPair(result, candidate)) {
      const vetoP = SINGLE_PAIR_VETO[i] || 0;
      if (Math.random() < vetoP) {
        const exclude = new Set(result);
        candidate = randomSymbol(exclude);
      }
    }

    result.push(candidate);
  }
  return result;
}

function rollResult() {
  let r, mult;
  do {
    r = rollOnce();
    mult = bestMultiplier(r);

    // optionally thin out 4-kind occurrence overall (affects specials too)
    const counts = classifyCounts(r);
    const isFourKind = Object.values(counts).some(v => v === 4);
    if (isFourKind && Math.random() < JACKPOT_REROLL_P) continue;

    break;
  } while (true);
  return { result: r, multiplier: mult };
}

// ---------- Command ----------
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

    const { result, multiplier } = rollResult();

    // Reveal reels one-by-one
    const display = [...spinningRow];
    for (let i = 0; i < REELS; i++) {
      await new Promise(r => setTimeout(r, REEL_DELAY_MS));
      display[i] = result[i];
      await interaction.editReply({ content: `🎰 Spinning...\n${display.join(' | ')}` });
    }

    // Compute payout; PROFIT-only multiplier
    const rawReturn = bet * (multiplier ?? 0);
    const totalBase = Math.floor(rawReturn);
    const isWin = totalBase > bet;
    const profit = isWin ? Math.floor((totalBase - bet) * coinMult) : 0;
    const winnings = isWin ? (bet + profit) : totalBase;

    // Outcome tag (which rule likely applied)
    const counts = classifyCounts(result);
    const g = genericHandMultiplier(counts);
    const s = specialMultiplier(counts);
    const n = normalMultiplier(counts);
    const used =
      (s >= g && s >= n) ? 'special' :
      (n >= g && n >= s) ? 'normal-specific' : 'generic';

    const handStr =
      g === GENERIC_PAYOUTS.four_kind ? 'four of a kind' :
      g === GENERIC_PAYOUTS.three_kind ? 'three of a kind' :
      g === GENERIC_PAYOUTS.two_pairs ? 'two pairs' :
      g === GENERIC_PAYOUTS.one_pair ? 'one pair' : 'no match';

    const outcomeStr = isWin
      ? `🎉 You won **${fmt(winnings - bet)}** coins profit! (${handStr} · ${used} x${(multiplier || 0).toFixed(1)}, profit×${coinMult.toFixed(2)})`
      : winnings === bet
      ? `😐 Break-even. (${handStr})`
      : `😢 You lost **${fmt(bet - winnings)}** coins. (${handStr})`;

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