// utils/levelUtils.js
// Smooth & Balanced Level Curve + Full Utilities
// - Early/Mid: โตนิ่ม ๆ ไม่กระโดด
// - Late: ยังท้าทาย แต่ไม่พุ่งเวอร์แบบเอ็กซ์โปเนนเชียล
// - คง API เดิม: getXPNeeded() = xpToNext()

// ---------------- Tunables (ปรับได้ตามรสนิยมเกมเพลย์) ----------------
// เลเวล 1→2
const BASE_XP = 110;

// โค้งหลัก (พหุนาม + เชิงเส้นผสม)
const XP_ALPHA = 1.60;    // ยิ่งสูง ค่าเลเวลยิ่งแพงขึ้นแบบ “นิ่ม”
const XP_BETA  = 0.007;   // ส่วนเพิ่มเชิงเส้น ช่วยช่วง mid-game

// บูสต์ปลายเกม “เบา ๆ” (ไม่พุ่งเวอร์)
const BOOST_L100 = 1.05;  // เริ่มรู้สึกยากขึ้นเล็กน้อยเมื่อ >=100
const BOOST_L150 = 1.12;  // เพิ่มอีกนิดเมื่อ >=150

// Smoothing: จำกัดอัตราเติบโตต่อเลเวลให้อยู่ในกรอบที่สมเหตุผล
//  - ไม่ให้กระโดดเกินไป (max growth)
//  - ไม่ให้แบนจนแทบไม่ต่าง (min growth)
const MIN_GROWTH_PER_LEVEL = 1.03; // อย่างน้อย +3% ต่อขั้น
const MAX_GROWTH_PER_LEVEL = 1.12; // ไม่เกิน ~+12% ต่อขั้น

// Late-game soft bonus (ค่อย ๆ ไต่ ไม่กระโดด)
const LATE_SOFT_START = 120;
const LATE_SOFT_A = 0.25;  // เพดานบูสต์รวม ~+25%
const LATE_SOFT_B = 0.015; // ความชันในการไต่

// UI
const MAX_BAR_SIZE = 20;
// เพดานเลเวล (0 = no cap)
const DEFAULT_MAX_LEVEL = 0;

// ---------------- Core Math ----------------

// โค้งพื้นฐาน “ก่อน” ทำ smoothing ต่อขั้น
function baseCurve(level) {
  const L = Math.max(1, Number(level || 1));

  let mult = 1.0;
  if (L >= 100) mult *= BOOST_L100;
  if (L >= 150) mult *= BOOST_L150;

  // late soft bonus: 1 + A * (1 - e^{-B*(L - start)})
  if (L >= LATE_SOFT_START) {
    const t = L - LATE_SOFT_START;
    mult *= 1 + LATE_SOFT_A * (1 - Math.exp(-LATE_SOFT_B * t));
  }

  const raw = BASE_XP * Math.pow(L, XP_ALPHA) * (1 + XP_BETA * L) * mult;
  return Math.max(1, Math.floor(raw));
}

/**
 * XP ที่ต้องใช้เพื่อไปจาก level → level+1 (หลัง smoothing)
 * - ใช้ baseCurve เป็น “ค่าตั้งต้น”
 * - บังคับให้ความต่างจากขั้นก่อนหน้าอยู่ในกรอบ [minGrowth, maxGrowth]
 * - ป้องกันบัค “ติดเพดานคงที่” ด้วยการ clamp ทิศทางที่ถูกต้อง
 */
function xpToNext(level) {
  const L = Math.max(1, Number(level || 1));
  if (L === 1) return baseCurve(1);

  const prev = baseCurve(L - 1);
  const curRaw = baseCurve(L);

  const minAllowed = Math.ceil(prev * MIN_GROWTH_PER_LEVEL);
  const maxAllowed = Math.floor(prev * MAX_GROWTH_PER_LEVEL);

  // ✅ สำคัญ: ต้อง clamp “curRaw” ให้อยู่ในช่วง [minAllowed, maxAllowed] ก่อน
  // แล้วค่อย ensure ว่าไม่ต่ำกว่า prev+1 เพื่อความเป็นขั้นบันได
  const clamped = Math.min(Math.max(curRaw, minAllowed), maxAllowed);
  return Math.max(prev + 1, clamped);
}

// Back-compat alias
function getXPNeeded(level) {
  return xpToNext(level);
}

/**
 * Total XP ที่ต้องใช้เพื่อ “ถึง” เลเวล L (รวมตั้งแต่เลเวล 1)
 * O(L) แต่เร็วพอสำหรับเกมเศรษฐกิจทั่วไป
 */
function totalXpForLevel(level) {
  const L = Math.floor(level);
  if (L <= 1) return 0;
  let sum = 0;
  for (let k = 1; k < L; k++) sum += xpToNext(k);
  return sum;
}

/**
 * แปลง total XP (สะสม) → { level, inLevel, toNext }
 * เดินหน้าเพิ่มทีละขั้น เพื่อแมตช์กับโค้ง smoothing
 */
function levelFromTotalXp(totalXp) {
  const S = Math.max(0, Number(totalXp || 0));
  if (S <= 0) return { level: 1, inLevel: 0, toNext: xpToNext(1) };

  let level = 1;
  let acc = 0;
  while (true) {
    const need = xpToNext(level);
    if (acc + need > S) break;
    acc += need;
    level += 1;
  }
  const inLevel = S - acc;
  const toNext = xpToNext(level);
  return { level, inLevel, toNext };
}

// ---------------- Progress Bar ----------------
function generateProgressBar(current, total, size = MAX_BAR_SIZE, charset = {}) {
  const { filled = '▰', empty = '▱', left = '', right = '' } = charset;
  const t = Math.max(1, Number(total || 1));
  const ratio = Math.max(0, Math.min(1, Number(current || 0) / t));
  const fillCount = Math.round(size * ratio);
  const emptyCount = Math.max(0, size - fillCount);
  return `${left}${filled.repeat(fillCount)}${empty.repeat(emptyCount)}${right}`;
}

function makeLevelProgress(level, inLevelXp, opts = {}) {
  const toNext = xpToNext(level);
  const barSize = Number(opts.barSize ?? MAX_BAR_SIZE);
  const bar = generateProgressBar(inLevelXp, toNext, barSize, opts.charset);
  const percent = Math.min(100, Math.max(0, Math.round((inLevelXp / Math.max(1, toNext)) * 100)));
  return { level, inLevel: inLevelXp, toNext, bar, percent };
}

// ---------------- Add XP (รองรับ multipliers + ล้นหลายเลเวล) ----------------
/**
 * เพิ่ม XP ให้คู่ (level, inLevelXp)
 * opts:
 *  - xpMultiplier: ตัวคูณเฉพาะผู้ใช้ (เช่น premium)
 *  - globalMultiplier: ตัวคูณรวม (เช่น event)
 *  - round: ปัดเป็นก้าวทีละ N (เช่น 5/10)
 *  - maxLevel: เพดานเลเวล (0 = ไม่มี)
 */
function addXp(level, inLevelXp, baseGain, opts = {}) {
  let L = Math.max(1, Math.floor(level || 1));
  let X = Math.max(0, Math.floor(inLevelXp || 0));

  const mult = Math.max(0, Number(opts.xpMultiplier ?? 1)) * Math.max(0, Number(opts.globalMultiplier ?? 1));
  let gain = Math.max(0, Number(baseGain || 0)) * mult;

  const step = Math.max(1, Math.floor(opts.round ?? 1));
  gain = Math.floor(gain / step) * step;

  let remaining = Math.floor(gain);
  let levelsUp = 0;
  const cap = Math.max(0, Math.floor(opts.maxLevel || DEFAULT_MAX_LEVEL)); // 0 = no cap
  let capped = false;

  while (remaining > 0) {
    const need = xpToNext(L) - X;       // ต้องเติมอีกเท่าไหร่ถึงจะอัป
    if (remaining >= need) {
      remaining -= need;
      L += 1;
      X = 0;
      levelsUp += 1;

      if (cap && L >= cap) {
        L = cap;
        // กัน X เกิน next (เวลามี cap)
        X = Math.min(xpToNext(L) - 1, X);
        capped = true;
        break;
      }
    } else {
      X += remaining;
      remaining = 0;
    }
  }

  return { level: L, inLevel: X, gained: Math.floor(gain), levelsUp, capped };
}

// ---------------- UI Helper ----------------
function formatLevelLine(level, inLevelXp, opts = {}) {
  const p = makeLevelProgress(level, inLevelXp, opts);
  return `Level **${p.level}** — **${fmt(p.inLevel)} / ${fmt(p.toNext)} XP** (${p.percent}%)\n${p.bar}`;
}

function fmt(n) { return new Intl.NumberFormat().format(Number(n || 0)); }

// ---------------- Exports ----------------
module.exports = {
  // Tunables (ถ้าโมดูลอื่นอยากอ่าน)
  BASE_XP, XP_ALPHA, XP_BETA,
  MAX_BAR_SIZE, DEFAULT_MAX_LEVEL,

  // Core math
  xpToNext,            // <- ใช้ใน messageCreate.js / commands
  getXPNeeded,         // <- alias back-compat
  totalXpForLevel,
  levelFromTotalXp,

  // Bars + UI
  generateProgressBar,
  makeLevelProgress,
  formatLevelLine,

  // XP Gain
  addXp,
};
