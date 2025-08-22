// commands/blackjack.js
// Blackjack with buttons (Hit / Stand / Double), atomic wallet updates,
// profit-only coin multiplier, and safe concurrency guard.
//
// Payouts:
// - Natural Blackjack (player 2-card 21, dealer not BJ): 3:2
// - Normal win: 1:1
// - Push: refund stake
// - Double: doubles stake; no blackjack payout (only 1:1 possible after double)
//
// Requires:
// - initUser(user, db)
// Schema assumption: users(user_id TEXT PRIMARY KEY, money BIGINT, coin_multiplier NUMERIC)
//
// Notes:
// - We deduct initial bet immediately (atomic).
// - On Double we attempt to deduct extra bet atomically at click time.
// - On settle we credit: push -> stake; win -> bet + profit(base*coinMult); loss -> 0
//   where base profit = stake for normal win OR Math.floor(1.5 * stake) for natural BJ.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  MessageFlags,
} = require('discord.js');
const { initUser } = require('../utils/initUser');

// ---------- CONFIG ----------
const REVEAL_DELAY_MS = 700;     // หน่วงตอนค่อย ๆ เปิดไพ่ (เล็กน้อยเพื่ออรรถรส)
const TURN_TIMEOUT_MS = 60_000;  // timeout ต่อเกม
const COLORS = { GREEN: 0x22c55e, RED: 0xef4444, GOLD: 0xf59e0b, BLURPLE: 0x5865f2 };
const CURRENCY_EMOJI = '<a:PixelCoin:1392196932926967858>';

// guard ไม่ให้เล่นเกมซ้อน (ต่อ user)
const activeGames = new Set();

// ---------- Cards ----------
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const RANK_VAL = { J:10, Q:10, K:10, A:11 };

function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  // shuffle (Fisher–Yates)
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 'A') { total += 11; aces++; }
    else if ('JQK'.includes(c.r)) total += 10;
    else total += Number(c.r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  const soft = aces > 0; // มี A นับ 11 เหลืออยู่ไหม
  return { total, soft };
}

function isBlackjack(cards) {
  if (cards.length !== 2) return false;
  const v = handValue(cards).total;
  return v === 21;
}

function cardStr(c) { return `${c.r}${c.s}`; }

function renderHands(player, dealer, revealDealer = false) {
  const pStr = player.map(cardStr).join(' ');
  const dStr = revealDealer
    ? dealer.map(cardStr).join(' ')
    : `${cardStr(dealer[0])} ▒▒`;
  const pVal = handValue(player).total;
  const dVal = revealDealer ? handValue(dealer).total : '??';
  return `**You:** ${pStr}  (**${pVal}**)\n**Dealer:** ${dStr}  (**${dVal}**)`;
}

const fmt = (n) => new Intl.NumberFormat().format(Math.max(0, Number(n || 0)));

function controlsRow(disabled = false, allowDouble = false, uid = 'u', nonce = 'x') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj:${uid}:${nonce}:hit`)
      .setLabel('Hit')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`bj:${uid}:${nonce}:stand`)
      .setLabel('Stand')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`bj:${uid}:${nonce}:double`)
      .setLabel('Double')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled || !allowDouble),
  );
}

// ---------- Command ----------
module.exports = {
  name: 'blackjack',
  description: 'Play Blackjack (Hit/Stand/Double).',
  data: new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Play Blackjack')
    .addStringOption(o =>
      o.setName('bet')
        .setDescription('Bet amount (number or "all")')
        .setRequired(true)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {import('pg').Pool} db
   */
  async execute(interaction, db) {
    const userId = interaction.user.id;
    if (activeGames.has(userId)) {
      return interaction.reply({ content: '⛔ You already have an active blackjack game.', flags: MessageFlags.Ephemeral });
    }
    activeGames.add(userId);

    try {
      const user = await initUser(interaction.user, db);
      if (!user) {
        return interaction.reply({ content: '❌ You need a profile to play.', flags: MessageFlags.Ephemeral });
      }

      const coinMult = Number(user.coin_multiplier ?? 1.0);
      const wallet = Number(user.money || 0);
      const betInput = (interaction.options.getString('bet') || '').trim().toLowerCase();

      let bet;
      if (betInput === 'all') bet = wallet;
      else if (/^\d+$/.test(betInput.replace(/,/g, ''))) bet = Math.floor(Number(betInput.replace(/,/g, '')));
      else bet = NaN;

      if (!Number.isFinite(bet) || bet <= 0) {
        return interaction.reply({ content: '❌ Bet must be a whole number > 0 or "all".', flags: MessageFlags.Ephemeral });
      }
      if (wallet < bet) {
        return interaction.reply({ content: `💸 Not enough coins. Balance: **${fmt(wallet)}** ${CURRENCY_EMOJI}`, flags: MessageFlags.Ephemeral });
      }

      // Deduct initial bet atomically
      {
        const { rowCount } = await db.query(
          `UPDATE users SET money = money - $2 WHERE user_id = $1 AND money >= $2`,
          [userId, bet]
        );
        if (rowCount === 0) {
          return interaction.reply({ content: '⚠️ Balance changed. Bet not deducted.', flags: MessageFlags.Ephemeral });
        }
      }

      // Init game state
      const deck = newDeck();
      const player = [deck.pop(), deck.pop()];
      const dealer = [deck.pop(), deck.pop()];
      let stake = bet;            // total staked amount (includes double when used)
      let canDouble = true;       // allowed only before any Hit (i.e., at 2 cards)
      let finished = false;
      const nonce = Math.random().toString(36).slice(2, 8);

      // Immediate settle if natural blackjack
      const playerBJ = isBlackjack(player);
      const dealerBJ = isBlackjack(dealer);

      // helper to produce embed
      const makeEmbed = (title, color, reveal = false, extra = '') => {
        return new EmbedBuilder()
          .setTitle(title)
          .setColor(color)
          .setDescription(`${renderHands(player, dealer, reveal)}${extra ? '\n\n' + extra : ''}`)
          .setFooter({ text: interaction.user.username, iconURL: interaction.user.displayAvatarURL({ forceStatic: false }) })
          .setTimestamp();
      };

      // settlement function (win/lose/push)
      const settle = async (resultType, opts = {}) => {
        // resultType: 'win' | 'blackjack' | 'push' | 'lose'
        // opts: { reason }
        finished = true;

        let baseProfit = 0;
        if (resultType === 'win') baseProfit = stake;                 // 1:1
        else if (resultType === 'blackjack') baseProfit = Math.floor(stake * 1.5); // 3:2
        else if (resultType === 'push') baseProfit = 0;
        else baseProfit = -stake;

        let credit = 0;
        let outcomeMsg = '';
        if (baseProfit > 0) {
          const profit = Math.floor(baseProfit * coinMult);
          credit = bet + profit; // return original bet + profit (profit already applied coinMult)
          outcomeMsg = resultType === 'blackjack'
            ? `🂱 **Blackjack!** Profit: **${fmt(profit)}** ${CURRENCY_EMOJI} (base 3:2, profit×${coinMult.toFixed(2)})`
            : `🎉 You win! Profit: **${fmt(profit)}** ${CURRENCY_EMOJI} (base x1.0, profit×${coinMult.toFixed(2)})`;
        } else if (baseProfit === 0) {
          credit = stake; // refund stake
          outcomeMsg = `😐 Push — stake refunded.`;
        } else {
          credit = 0; // lost stake (already deducted)
          outcomeMsg = `😢 You lose.`;
        }

        // Credit atomically
        if (credit > 0) {
          await db.query(
            `UPDATE users SET money = money + $2 WHERE user_id = $1`,
            [userId, credit]
          );
        }

        const embed = makeEmbed('🃏 Blackjack — Result', baseProfit > 0 ? COLORS.GREEN : baseProfit === 0 ? COLORS.GOLD : COLORS.RED, true,
          `${outcomeMsg}${opts.reason ? `\n🛈 ${opts.reason}` : ''}\n\n` +
          `💰 Bet: **${fmt(bet)}** ${CURRENCY_EMOJI}${stake > bet ? `  •  Double: **+${fmt(stake - bet)}**` : ''}`
        );

        return interaction.editReply({ embeds: [embed], components: [] });
      };

      // If immediate blackjack cases:
      if (playerBJ || dealerBJ) {
        await interaction.reply({
          embeds: [makeEmbed('🃏 Blackjack', COLORS.BLURPLE, false, 'Checking for naturals...')],
          components: [controlsRow(true, false, userId, nonce)],
        });
        await new Promise(r => setTimeout(r, REVEAL_DELAY_MS));
        if (playerBJ && !dealerBJ) {
          return settle('blackjack');
        } else if (playerBJ && dealerBJ) {
          return settle('push', { reason: 'Both have Blackjack.' });
        } else {
          return settle('lose', { reason: 'Dealer has Blackjack.' });
        }
      }

      // Start interactive round
      await interaction.reply({
        embeds: [makeEmbed('🃏 Blackjack', COLORS.BLURPLE, false, `💰 Bet: **${fmt(bet)}** ${CURRENCY_EMOJI}`)],
        components: [controlsRow(false, canDouble, userId, nonce)],
      });

      const msg = await interaction.fetchReply();

      const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: TURN_TIMEOUT_MS,
        filter: (i) => i.customId.startsWith(`bj:${userId}:${nonce}:`) && i.user.id === userId,
      });

      collector.on('collect', async (btn) => {
        if (finished) return;
        const action = btn.customId.split(':').pop(); // hit|stand|double

        try {
          await btn.deferUpdate();

          if (action === 'hit') {
            player.push(deck.pop());
            canDouble = false;
            const v = handValue(player).total;
            await interaction.editReply({
              embeds: [makeEmbed('🃏 Blackjack — You hit', COLORS.BLURPLE, false, `💰 Bet: **${fmt(stake)}** ${CURRENCY_EMOJI}`)],
              components: [controlsRow(false, false, userId, nonce)],
            });

            if (v > 21) {
              // Bust -> lose
              await new Promise(r => setTimeout(r, REVEAL_DELAY_MS));
              finished = true;
              return settle('lose', { reason: 'Busted over 21.' });
            }
          }

          if (action === 'double' && canDouble) {
            // Try deduct additional bet atomically
            const { rowCount } = await db.query(
              `UPDATE users SET money = money - $2 WHERE user_id = $1 AND money >= $2`,
              [userId, bet]
            );
            if (rowCount === 0) {
              // cannot double due to insufficient funds
              canDouble = false;
              return interaction.editReply({
                embeds: [makeEmbed('🃏 Blackjack — Cannot Double', COLORS.GOLD, false, `⚠️ Not enough balance to double. Proceed with normal bet.\n\n💰 Bet: **${fmt(stake)}** ${CURRENCY_EMOJI}`)],
                components: [controlsRow(false, false, userId, nonce)],
              });
            }
            stake += bet; // doubled
            canDouble = false;

            // Draw exactly one card then stand
            player.push(deck.pop());
            await interaction.editReply({
              embeds: [makeEmbed('🃏 Blackjack — You doubled', COLORS.BLURPLE, false, `💰 Stake: **${fmt(stake)}** ${CURRENCY_EMOJI}`)],
              components: [controlsRow(true, false, userId, nonce)],
            });

            const v = handValue(player).total;
            if (v > 21) {
              await new Promise(r => setTimeout(r, REVEAL_DELAY_MS));
              finished = true;
              return settle('lose', { reason: 'Busted after doubling.' });
            }

            // proceed to dealer play
            await new Promise(r => setTimeout(r, REVEAL_DELAY_MS));
            return resolveDealer();
          }

          if (action === 'stand') {
            canDouble = false;
            await interaction.editReply({
              embeds: [makeEmbed('🃏 Blackjack — You stand', COLORS.BLURPLE, false, `💰 Stake: **${fmt(stake)}** ${CURRENCY_EMOJI}`)],
              components: [controlsRow(true, false, userId, nonce)],
            });
            await new Promise(r => setTimeout(r, REVEAL_DELAY_MS));
            return resolveDealer();
          }
        } catch (e) {
          console.error('blackjack button error:', e);
        }
      });

      collector.on('end', async () => {
        if (finished) return;
        // timeout -> treat as Stand
        try {
          await interaction.editReply({
            components: [controlsRow(true, false, userId, nonce)],
          });
          await resolveDealer(true);
        } catch (e) {
          // ignore
        }
      });

      // Dealer resolution
      const resolveDealer = async (timeoutStand = false) => {
        if (finished) return;
        // Reveal dealer, then draw to 17 (stand on soft 17)
        let dv = handValue(dealer);
        await interaction.editReply({
          embeds: [makeEmbed(timeoutStand ? '🕒 Timeout — standing' : '🃏 Blackjack — Dealer turn', COLORS.BLURPLE, true, `💰 Stake: **${fmt(stake)}** ${CURRENCY_EMOJI}`)],
          components: [controlsRow(true, false, userId, nonce)],
        });

        await new Promise(r => setTimeout(r, REVEAL_DELAY_MS));
        while (dv.total < 17 || (dv.total === 17 && dv.soft === true)) {
          dealer.push(deck.pop());
          dv = handValue(dealer);
          await interaction.editReply({
            embeds: [makeEmbed('🃏 Blackjack — Dealer draws', COLORS.BLURPLE, true, `💰 Stake: **${fmt(stake)}** ${CURRENCY_EMOJI}`)],
            components: [controlsRow(true, false, userId, nonce)],
          });
          await new Promise(r => setTimeout(r, 450));
        }

        const pv = handValue(player).total;
        const dtotal = dv.total;

        if (dtotal > 21) return settle('win', { reason: 'Dealer busts.' });
        if (pv > dtotal) return settle('win');
        if (pv === dtotal) return settle('push');
        return settle('lose');
      };

    } finally {
      // always unlock
      activeGames.delete(interaction.user.id);
    }
  },
};
