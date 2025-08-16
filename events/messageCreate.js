// events/messageCreate.js
// Message handler (Big Heist trigger + balanced, truly-random XP system)
//
// แนวคิด XP แบบใหม่
// - ตั้ง "จำนวนข้อความเฉลี่ยต่อเลเวล" (MESSAGES_PER_LEVEL) → คำนวณ XP ต่อข้อความจาก xpToNext(level) / MESSAGES_PER_LEVEL
// - ใส่ความสุ่ม (jitter) และ lucky bonus เล็กน้อย เพื่อให้ตัวเลขไม่นิ่ง
// - ใช้เพดานขั้นต่ำ/สูงสุด "แบบไดนามิก" ตาม xpToNext — ไม่ใช้ตัวเลขตายตัว เช่น 200/500 อีก
// - มีคูลดาวน์การได้ XP ต่อผู้ใช้ (แนะนำ 20s เพื่อกันสแปม)
//
// หมายเหตุ: อย่าลืมส่ง db ให้ initUser ตามเวอร์ชันล่าสุดของโปรเจ็กต์คุณ

const {
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { xpToNext } = require('../utils/levelUtils');
const { initUser } = require('../utils/initUser');

// ---------- Heist config/state ----------
const HEIST_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 ชั่วโมง ระหว่างการเกิดอีเวนต์
const HEIST_CHANCE_PER_MESSAGE = 0.015;       // 1.5% ต่อข้อความที่เข้าเงื่อนไข
const HEIST_DURATION_MS = 5 * 60 * 1000;      // เปิด 5 นาที

let lastHeistSpawnAt = 0;
let heistActive = false;
let heistTimer = null;

// ---------- XP config/state ----------
const XP_COOLDOWN_MS = 1_000;          // 20 วินาทีต่อผู้ใช้ ต่อการให้ XP
const MESSAGES_PER_LEVEL = 360;         // โดยเฉลี่ย ~360 ข้อความ / เลเวล (~2 ชม. ถ้าคุยเรื่อย ๆ)
const FASTEST_PORTION = 0.20;           // เร็วสุด ~20% ของข้อความเฉลี่ย/เลเวล
const JITTER_PCT = 0.20;                // สุ่มแกว่ง ±20%

// ขั้นต่ำ/สูงสุด "แบบไดนามิก" (ขึ้นกับ need ของเลเวลนั้น)
const MIN_FLOOR_ABS = 5;                // อย่างน้อยสุดไม่ต่ำกว่า 5
const MIN_FLOOR_NEED_RATIO = 1 / 1200;  // อย่างน้อย ~0.083% ของ need
const MAX_CEIL_MIN_MSGS = 30;           // อย่างช้าที่สุดให้เผื่อเพดานเร็วสุด
// dynamicMax ≈ need / max(30, MESSAGES_PER_LEVEL*FASTEST_PORTION)

// lucky bonus (เพิ่มสีสันเล็กน้อย)
const LUCKY_SMALL_CHANCE = 0.05;        // 5% โชคเล็ก
const LUCKY_SMALL_BONUS  = 0.03;        // +3% ของ perMsgTarget
const LUCKY_BIG_CHANCE   = 0.01;        // 1% โชคกลาง
const LUCKY_BIG_BONUS    = 0.07;        // +7% ของ perMsgTarget

// แผนที่ cooldown ต่อผู้ใช้
const lastXpAt = new Map();

// ---------- Heist helper ----------
async function maybeTriggerHeist(message) {
  const now = Date.now();
  if (heistActive) return;
  if (now - lastHeistSpawnAt < HEIST_COOLDOWN_MS) return;
  if (Math.random() >= HEIST_CHANCE_PER_MESSAGE) return;

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
  }, HEIST_DURATION_MS);
}

// ---------- XP helper ----------
// สุ่มแบบกระจายสามเหลี่ยม (ค่าเฉลี่ยกลาง ๆ แต่ยังสุ่มได้กว้างกว่า uniform ±ขอบ)
function randTriangular(mean, amplitudePct) {
  // ช่วง = mean * amplitudePct
  const amp = Math.max(0, Number(amplitudePct || 0)) * mean;
  if (amp <= 0) return Math.round(mean);
  // สุ่มสองครั้งแล้วเฉลี่ย เพื่อได้ distribution คลาดเคลื่อนเข้ากลางมากขึ้น
  const a = mean - amp;
  const b = mean + amp;
  const r1 = a + Math.random() * (b - a);
  const r2 = a + Math.random() * (b - a);
  return Math.round((r1 + r2) / 2);
}

function computeMessageXP(userRow) {
  const lvl = Math.max(1, Number(userRow?.level || 1));
  const need = Math.max(1, xpToNext(lvl)); // XP ที่ต้องใช้เพื่ออัปไปเลเวลถัดไป

  // เป้าหมาย XP ต่อข้อความ (ค่าเฉลี่ย)
  const perMsgTarget = Math.max(1, Math.floor(need / MESSAGES_PER_LEVEL));

  // สุ่มแบบ triangular รอบ ๆ ค่าเฉลี่ย (ดูธรรมชาติกว่า uniform)
  let gain = randTriangular(perMsgTarget, JITTER_PCT);

  // Lucky bonus (ค่อย ๆ เติมทีละชั้น เพื่อยังคุมกรอบด้วย dynamic max ภายหลัง)
  if (Math.random() < LUCKY_SMALL_CHANCE) {
    gain += Math.round(perMsgTarget * LUCKY_SMALL_BONUS);
  }
  if (Math.random() < LUCKY_BIG_CHANCE) {
    gain += Math.round(perMsgTarget * LUCKY_BIG_BONUS);
  }

  // ตัวคูณผู้ใช้ (เช่น xpmult)
  const xpMult = Math.max(0, Number(userRow?.xp_multiplier ?? 1.0));
  gain = Math.round(gain * xpMult);

  // ขั้นต่ำไดนามิก: อย่างน้อยสุดไม่ต่ำกว่า MIN_FLOOR_ABS หรือ ~0.083% ของ need
  const minDynamic = Math.max(MIN_FLOOR_ABS, Math.floor(need * MIN_FLOOR_NEED_RATIO));

  // เพดานไดนามิก: เร็วสุด ~20% ของข้อความเฉลี่ย/เลเวล หรืออย่างน้อย 30 ข้อความ
  const fastestMsgs = Math.max(MAX_CEIL_MIN_MSGS, Math.floor(MESSAGES_PER_LEVEL * FASTEST_PORTION));
  const maxDynamic = Math.max(minDynamic + 1, Math.ceil(need / fastestMsgs));

  // สุดท้าย clamp เข้ากรอบไดนามิก
  gain = Math.max(minDynamic, Math.min(maxDynamic, gain));

  return gain;
}

async function grantMessageXP(message, db) {
  const uid = message.author.id;
  const now = Date.now();

  // Anti-spam cooldown
  const last = lastXpAt.get(uid) || 0;
  if (now - last < XP_COOLDOWN_MS) return;
  lastXpAt.set(uid, now);

  // Ensure row exists (initUser เวอร์ชันล่าสุด รับ db)
  const user = await initUser(message.author, db);

  const gained = computeMessageXP(user);
  let xp = Math.max(0, Number(user.xp || 0)) + gained;
  let lvl = Math.max(1, Number(user.level || 1));

  // รองรับล้นหลายเลเวล
  let levelsGained = 0;
  for (;;) {
    const needed = xpToNext(lvl);
    if (xp < needed) break;
    xp -= needed;
    lvl += 1;
    levelsGained += 1;
  }

  try {
    await db.query('UPDATE users SET xp = $1, level = $2 WHERE user_id = $3', [xp, lvl, uid]);
  } catch (e) {
    console.error('Failed to update XP:', e);
    return;
  }

  if (levelsGained > 0) {
    const embed = new EmbedBuilder()
      .setTitle('🌟 Level Up!')
      .setDescription(`**${message.author.username}** reached **level ${lvl}** 🎉\n(+${gained} XP)`)
      .setColor(0x22c55e)
      .setThumbnail(message.author.displayAvatarURL({ forceStatic: false }))
      .setFooter({ text: `Levels gained this message: ${levelsGained}` })
      .setTimestamp();
    try { await message.channel.send({ embeds: [embed] }); } catch {}
  }
}

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
      // ถ้าต้องการให้ XP เฉพาะในกิลด์ให้เปิดบรรทัดล่าง:
      // if (!message.guild) return;

      await maybeTriggerHeist(message);
      await grantMessageXP(message, db);
    } catch (err) {
      console.error('messageCreate error:', err);
    }
  },

  // ให้โมดูลอื่นตรวจสถานะอีเวนต์ได้
  isBigHeistActive: () => exportedActiveGetter(),
};
