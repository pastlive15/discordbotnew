// events/messageCreate.js
// Spec: No cooldown, no "message quality" factor.
// XP is drawn from bands 5–9 (common), 10–20 (less common), 21–30 (rare).
// Within each band, higher XP has lower probability (monotone decreasing).
// Final XP is clamped to dynamic [min..max] derived from xpToNext(level).

const {
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { xpToNext } = require('../utils/levelUtils');
const { initUser } = require('../utils/initUser');

// ---------- Heist (kept as before) ----------
const HEIST = Object.freeze({
  COOLDOWN_MS: 2 * 60 * 60 * 1000, // 2h between spawns
  CHANCE_PER_MSG: 0.015,           // 1.5% per eligible message
  DURATION_MS: 5 * 60 * 1000,      // active 5m
});
let heistActive = false;
let lastHeistSpawnAt = 0;
let heistTimer = null;

async function maybeTriggerHeist(message) {
  const now = Date.now();
  if (heistActive) return;
  if (now - lastHeistSpawnAt < HEIST.COOLDOWN_MS) return;
  if (Math.random() >= HEIST.CHANCE_PER_MSG) return;

  heistActive = true;
  lastHeistSpawnAt = now;

  const embed = new EmbedBuilder()
    .setTitle('💥 Big Vault Heist Activated!')
    .setColor(0x991b1b)
    .setDescription(
      '🚨 For the next **5 minutes**, one lucky thief can attempt a **Big Vault Robbery**!\n\n' +
      '💰 Reward: **Up to 30%** of the vault\n' +
      '📈 Success Rate: **TRIPLE normal**\n\n' +
      '⚠️ Only **one** person can claim the heist!\n' +
      'Click the button below to try your luck!'
    )
    .setFooter({ text: 'This offer disappears in 5 minutes.' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vaultrob_bigheist')
      .setLabel('💣 Rob the Vault')
      .setStyle(ButtonStyle.Danger),
  );

  try {
    await message.channel.send({ embeds: [embed], components: [row] });
  } catch {
    heistActive = false;
    return;
  }

  clearTimeout(heistTimer);
  heistTimer = setTimeout(() => {
    heistActive = false;
    heistTimer = null;
  }, HEIST.DURATION_MS);
}

// ---------- XP bands & dynamic bounds ----------
const MIN_FLOOR_ABS = 1;                // absolute minimum per message
const MIN_FLOOR_NEED_RATIO = 1 / 1500;  // ≥ ~0.066% of need
const MAX_PORTION_PER_MESSAGE = 1 / 60; // ≤ ~1.67% of need

// Band weights (sum ≈ 1). Tune freely.
const BAND_WEIGHTS = Object.freeze({
  // 5–9: common   | 10–20: less common | 21–30: rare
  A: 0.40,  // 5–9
  B: 0.35,  // 10–20
  C: 0.25,  // 21–30
});

// Geometric-like decay inside each band (higher XP rarer).
// Larger DECAY_K => steeper drop-off.
const DECAY_K = 0.22;

// Sample a band according to weights
function pickBand() {
  const r = Math.random();
  if (r < BAND_WEIGHTS.A) return [5, 9];
  if (r < BAND_WEIGHTS.A + BAND_WEIGHTS.B) return [10, 20];
  return [21, 30];
}

// Sample an integer x in [min,max] with P(x) ∝ exp(-k * (x - min))
function sampleMonotone(min, max, k = DECAY_K) {
  const n = max - min + 1;
  if (n <= 1) return min;

  // Precompute unnormalized weights
  let sum = 0;
  const w = new Array(n);
  for (let i = 0; i < n; i++) {
    const weight = Math.exp(-k * i);
    w[i] = weight;
    sum += weight;
  }
  // Draw
  let r = Math.random() * sum;
  for (let i = 0; i < n; i++) {
    r -= w[i];
    if (r <= 0) return min + i;
  }
  return max;
}

function computeXpGain(userRow) {
  const level = Math.max(1, Number(userRow?.level || 1));
  const need = Math.max(1, xpToNext(level));

  // Dynamic bounds tied to level
  const minDynamic = Math.max(MIN_FLOOR_ABS, Math.floor(need * MIN_FLOOR_NEED_RATIO));
  const maxDynamic = Math.max(minDynamic + 1, Math.ceil(need * MAX_PORTION_PER_MESSAGE));

  // Draw from configured bands
  const [bMin, bMax] = pickBand();
  let gain = sampleMonotone(bMin, bMax);

  // Final clamp into dynamic bounds
  if (gain < minDynamic) gain = minDynamic;
  if (gain > maxDynamic) gain = maxDynamic;

  return { gain, minDynamic, maxDynamic };
}

async function applyXp(message, db) {
  const user = await initUser(message.author, db);

  const { gain } = computeXpGain(user);

  let xp = Math.max(0, Number(user.xp || 0)) + gain;
  let lvl = Math.max(1, Number(user.level || 1));

  // Multi-level overflow
  let levelsGained = 0;
  for (;;) {
    const need = xpToNext(lvl);
    if (xp < need) break;
    xp -= need;
    lvl += 1;
    levelsGained += 1;
  }

  try {
    await db.query('UPDATE users SET xp = $1, level = $2 WHERE user_id = $3', [
      xp, lvl, message.author.id,
    ]);
  } catch (e) {
    console.error('Failed to update XP:', e);
    return;
  }

  if (levelsGained > 0) {
    const embed = new EmbedBuilder()
      .setTitle('🌟 Level Up!')
      .setDescription(`**${message.author.username}** reached **level ${lvl}** 🎉\n(+${gain} XP)`)
      .setColor(0x22c55e)
      .setThumbnail(message.author.displayAvatarURL({ forceStatic: false }))
      .setFooter({ text: `Levels gained this message: ${levelsGained}` })
      .setTimestamp();
    try { await message.channel.send({ embeds: [embed] }); } catch {}
  }
}

// ---------- Exported event (compatible with your loader) ----------
module.exports = {
  name: Events.MessageCreate,

  /**
   * @param {import('discord.js').Message} message
   * @param {import('discord.js').Client} bot
   * @param {import('pg').Pool} db
   */
  async execute(message, bot, db) {
    try {
      if (message.author.bot) return;
      // If you want XP only in guilds:
      // if (!message.guild) return;

      await maybeTriggerHeist(message);
      await applyXp(message, db);
    } catch (err) {
      console.error('messageCreate error:', err);
    }
  },

  // expose heist status if needed
  isBigHeistActive: () => heistActive,
};
