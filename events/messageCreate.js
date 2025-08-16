// events/messageCreate.js
// Refactor from scratch: balanced per-message XP + Big Heist trigger,
// strong guards, cleaner structure, and fewer side-effects.

const {
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { xpToNext } = require('../utils/levelUtils');
const { initUser } = require('../utils/initUser');

// ---------------- Heist config/state ----------------
const HEIST = Object.freeze({
  COOLDOWN_MS: 2 * 60 * 60 * 1000,  // 2h between spawns
  CHANCE_PER_MSG: 0.015,            // 1.5% per eligible message
  DURATION_MS: 5 * 60 * 1000,       // 5 minutes active
});
let heistActive = false;
let lastHeistSpawnAt = 0;
let heistTimer = null;

// ---------------- XP config/state ----------------
const XP = Object.freeze({
  COOLDOWN_MS: 20 * 1000,         // anti-spam: 20s per user
  MESSAGES_PER_LEVEL: 360,        // average msgs per level
  FASTEST_PORTION: 0.20,          // ~20% of avg msgs at best case
  JITTER_PCT: 0.20,               // ±20% triangular jitter

  // dynamic floor/ceiling relative to xpToNext(level)
  MIN_FLOOR_ABS: 5,               // at least 5 XP
  MIN_FLOOR_NEED_RATIO: 1 / 1200, // at least ~0.083% of need
  MAX_CEIL_MIN_MSGS: 30,          // cap fastest path
  // dynamicMax ≈ need / max(30, MESSAGES_PER_LEVEL * FASTEST_PORTION)

  // lucky bonus layers (small spice, still safe under dynamic cap)
  LUCKY_SMALL_CHANCE: 0.05,       // 5%
  LUCKY_SMALL_BONUS: 0.03,        // +3% of target
  LUCKY_BIG_CHANCE: 0.01,         // 1%
  LUCKY_BIG_BONUS: 0.07,          // +7% of target
});

const lastXpAt = new Map(); // per-user XP cooldown

// ---------------- Heist helpers ----------------
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
      .setStyle(ButtonStyle.Danger)
  );

  try {
    await message.channel.send({ embeds: [embed], components: [row] });
  } catch (e) {
    console.warn('Failed to send Big Heist message:', e?.message || e);
    heistActive = false;
    return;
  }

  clearTimeout(heistTimer);
  heistTimer = setTimeout(() => {
    heistActive = false;
    heistTimer = null;
  }, HEIST.DURATION_MS);
}

// ---------------- XP helpers ----------------
function randTriangular(mean, amplitudePct) {
  const amp = Math.max(0, Number(amplitudePct || 0)) * mean;
  if (amp <= 0) return Math.round(mean);
  const a = mean - amp;
  const b = mean + amp;
  const r1 = a + Math.random() * (b - a);
  const r2 = a + Math.random() * (b - a);
  return Math.round((r1 + r2) / 2);
}

function computePerMessageXP(userRow) {
  const level = Math.max(1, Number(userRow?.level || 1));
  const need = Math.max(1, xpToNext(level));

  // average target per message
  const perMsgTarget = Math.max(1, Math.floor(need / XP.MESSAGES_PER_LEVEL));

  // randomize around target
  let gain = randTriangular(perMsgTarget, XP.JITTER_PCT);

  // lucky bonuses (added before clamping)
  if (Math.random() < XP.LUCKY_SMALL_CHANCE) {
    gain += Math.round(perMsgTarget * XP.LUCKY_SMALL_BONUS);
  }
  if (Math.random() < XP.LUCKY_BIG_CHANCE) {
    gain += Math.round(perMsgTarget * XP.LUCKY_BIG_BONUS);
  }

  // per-user multiplier (e.g., boosters)
  const xpMult = Math.max(0, Number(userRow?.xp_multiplier ?? 1.0));
  gain = Math.round(gain * xpMult);

  // dynamic min/max frame based on need
  const minDynamic = Math.max(
    XP.MIN_FLOOR_ABS,
    Math.floor(need * XP.MIN_FLOOR_NEED_RATIO)
  );
  const fastestMsgs = Math.max(
    XP.MAX_CEIL_MIN_MSGS,
    Math.floor(XP.MESSAGES_PER_LEVEL * XP.FASTEST_PORTION)
  );
  const maxDynamic = Math.max(minDynamic + 1, Math.ceil(need / fastestMsgs));

  // clamp into the dynamic frame
  gain = Math.max(minDynamic, Math.min(maxDynamic, gain));
  return gain;
}

async function grantMessageXP(message, db) {
  const uid = message.author.id;
  const now = Date.now();

  // anti-spam cooldown (per user)
  const last = lastXpAt.get(uid) || 0;
  if (now - last < XP.COOLDOWN_MS) return;
  lastXpAt.set(uid, now);

  // ensure user exists
  const user = await initUser(message.author, db);

  const gained = computePerMessageXP(user);
  let xp = Math.max(0, Number(user.xp || 0)) + gained;
  let lvl = Math.max(1, Number(user.level || 1));

  // handle multi-level overflows
  let levelsGained = 0;
  for (;;) {
    const needed = xpToNext(lvl);
    if (xp < needed) break;
    xp -= needed;
    lvl += 1;
    levelsGained += 1;
  }

  try {
    await db.query(
      'UPDATE users SET xp = $1, level = $2 WHERE user_id = $3',
      [xp, lvl, uid]
    );
  } catch (e) {
    console.error('Failed to update XP:', e);
    return;
  }

  if (levelsGained > 0) {
    const embed = new EmbedBuilder()
      .setTitle('🌟 Level Up!')
      .setDescription(
        `**${message.author.username}** reached **level ${lvl}** 🎉\n(+${gained} XP)`
      )
      .setColor(0x22c55e)
      .setThumbnail(message.author.displayAvatarURL({ forceStatic: false }))
      .setFooter({ text: `Levels gained this message: ${levelsGained}` })
      .setTimestamp();
    try {
      await message.channel.send({ embeds: [embed] });
    } catch {}
  }
}

// ---------------- Exported event ----------------
let exportedActiveGetter = () => heistActive;

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
      // If you only want XP in guilds, uncomment:
      // if (!message.guild) return;

      // Optional: ignore very short/empty messages to reduce noise
      // if (!message.content?.trim() && message.attachments.size === 0) return;

      await maybeTriggerHeist(message);
      await grantMessageXP(message, db);
    } catch (err) {
      console.error('messageCreate error:', err);
    }
  },

  // allow other modules to check heist state
  isBigHeistActive: () => exportedActiveGetter(),
};
