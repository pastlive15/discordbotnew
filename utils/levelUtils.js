// utils/levelUtils.js
// Refactored from scratch: same public API, clearer structure, safer math, memoized.

// ---------------- Tunables (defaults) ----------------
const DEFAULTS = Object.freeze({
  BASE_XP: 110,            // L1->L2 baseline
  XP_ALPHA: 1.60,          // polynomial growth (softly steeper at higher levels)
  XP_BETA: 0.007,          // linear blend for mid-game
  BOOST_L100: 1.05,        // light late-game boosts
  BOOST_L150: 1.12,
  MIN_GROWTH_PER_LEVEL: 1.03, // clamp range to avoid jumps
  MAX_GROWTH_PER_LEVEL: 1.12,
  LATE_SOFT_START: 120,    // soft bonus curve start
  LATE_SOFT_A: 0.25,       // max ~+25%
  LATE_SOFT_B: 0.015,      // slope
  MAX_BAR_SIZE: 20,
  DEFAULT_MAX_LEVEL: 0,    // 0 = no cap
});

// active configuration (mutable only via setConfig)
let CFG = { ...DEFAULTS };

/**
 * Update tunables at runtime (partial).
 * Unknown keys are ignored; invalid values are clamped safely.
 * @param {Partial<typeof DEFAULTS>} partial
 */
function setConfig(partial = {}) {
  if (!partial || typeof partial !== 'object') return;
  const next = { ...CFG, ...partial };
  // safety clamps
  next.BASE_XP = clampInt(next.BASE_XP, 1, 10_000);
  next.XP_ALPHA = clampNum(next.XP_ALPHA, 1.0, 3.0);
  next.XP_BETA = clampNum(next.XP_BETA, 0, 0.1);
  next.BOOST_L100 = clampNum(next.BOOST_L100, 1.0, 2.0);
  next.BOOST_L150 = clampNum(next.BOOST_L150, 1.0, 2.0);
  next.MIN_GROWTH_PER_LEVEL = clampNum(next.MIN_GROWTH_PER_LEVEL, 1.0, 1.5);
  next.MAX_GROWTH_PER_LEVEL = clampNum(next.MAX_GROWTH_PER_LEVEL, 1.0, 2.0);
  if (next.MAX_GROWTH_PER_LEVEL < next.MIN_GROWTH_PER_LEVEL) {
    next.MAX_GROWTH_PER_LEVEL = next.MIN_GROWTH_PER_LEVEL;
  }
  next.LATE_SOFT_START = clampInt(next.LATE_SOFT_START, 1, 10_000);
  next.LATE_SOFT_A = clampNum(next.LATE_SOFT_A, 0, 1);
  next.LATE_SOFT_B = clampNum(next.LATE_SOFT_B, 0, 1);
  next.MAX_BAR_SIZE = clampInt(next.MAX_BAR_SIZE, 5, 40);
  next.DEFAULT_MAX_LEVEL = clampInt(next.DEFAULT_MAX_LEVEL, 0, 10_000);
  CFG = next;
}

// ---------------- Core math (pure) ----------------

/**
 * Base (raw) XP curve before smoothing clamps.
 * @param {number} level >=1
 * @returns {number} integer XP required for this level step (raw)
 */
function baseCurve(level) {
  const L = Math.max(1, Math.floor(Number(level) || 1));

  let mult = 1.0;
  if (L >= 100) mult *= CFG.BOOST_L100;
  if (L >= 150) mult *= CFG.BOOST_L150;

  if (L >= CFG.LATE_SOFT_START) {
    const t = L - CFG.LATE_SOFT_START;
    mult *= 1 + CFG.LATE_SOFT_A * (1 - Math.exp(-CFG.LATE_SOFT_B * t));
  }

  const raw = CFG.BASE_XP * Math.pow(L, CFG.XP_ALPHA) * (1 + CFG.XP_BETA * L) * mult;
  return Math.max(1, Math.floor(raw));
}

// memoization for xpToNext (stable across common loops)
const xpNextMemo = new Map();

/**
 * XP needed to go from level -> level+1 after smoothing.
 * Smoothing clamps growth to [MIN, MAX] relative to prev step to avoid spikes.
 * @param {number} level
 */
function xpToNext(level) {
  const key = Math.max(1, Math.floor(level || 1));
  if (xpNextMemo.has(key)) return xpNextMemo.get(key);

  if (key === 1) {
    const v = baseCurve(1);
    xpNextMemo.set(key, v);
    return v;
  }

  const prev = baseCurve(key - 1);
  const curRaw = baseCurve(key);

  const minAllowed = Math.ceil(prev * CFG.MIN_GROWTH_PER_LEVEL);
  const maxAllowed = Math.floor(prev * CFG.MAX_GROWTH_PER_LEVEL);

  // Clamp and ensure stepwise increase
  const clamped = clampInt(curRaw, minAllowed, maxAllowed);
  const result = Math.max(prev + 1, clamped);

  xpNextMemo.set(key, result);
  return result;
}

/** Back-compat alias. */
function getXPNeeded(level) {
  return xpToNext(level);
}

/**
 * Total cumulative XP required to reach level L (sum of steps).
 * O(L) with memoized steps; adequate for gameplay use.
 */
function totalXpForLevel(level) {
  const L = Math.floor(level || 1);
  if (L <= 1) return 0;
  let sum = 0;
  for (let k = 1; k < L; k++) sum += xpToNext(k);
  return sum;
}

/**
 * Convert total accumulated XP -> { level, inLevel, toNext }.
 * Walk forward using the memoized xpToNext for perfect consistency.
 */
function levelFromTotalXp(totalXp) {
  const S = Math.max(0, Math.floor(Number(totalXp) || 0));
  if (S <= 0) return { level: 1, inLevel: 0, toNext: xpToNext(1) };

  let level = 1;
  let acc = 0;
  for (;;) {
    const need = xpToNext(level);
    if (acc + need > S) break;
    acc += need;
    level++;
  }
  const inLevel = S - acc;
  const toNext = xpToNext(level);
  return { level, inLevel, toNext };
}

// ---------------- Progress / UI ----------------

/**
 * Render a simple text progress bar.
 * @param {number} current
 * @param {number} total
 * @param {number} size
 * @param {{filled?:string, empty?:string, left?:string, right?:string}} charset
 */
function generateProgressBar(current, total, size = CFG.MAX_BAR_SIZE, charset = {}) {
  const { filled = '▰', empty = '▱', left = '', right = '' } = charset;
  const t = Math.max(1, Math.floor(total || 1));
  const ratio = clampNum((Number(current) || 0) / t, 0, 1);
  const fillCount = Math.round(size * ratio);
  const emptyCount = Math.max(0, size - fillCount);
  return `${left}${filled.repeat(fillCount)}${empty.repeat(emptyCount)}${right}`;
}

/**
 * Convenience progress info bundle for a level.
 */
function makeLevelProgress(level, inLevelXp, opts = {}) {
  const toNext = xpToNext(level);
  const barSize = clampInt(opts.barSize ?? CFG.MAX_BAR_SIZE, 5, 40);
  const bar = generateProgressBar(inLevelXp, toNext, barSize, opts.charset);
  const percent = Math.round(clampNum((Number(inLevelXp) || 0) / Math.max(1, toNext), 0, 1) * 100);
  return { level, inLevel: Math.max(0, Math.floor(inLevelXp || 0)), toNext, bar, percent };
}

// ---------------- XP Gain (multi-level overflow + caps) ----------------

/**
 * Add XP to a (level, inLevelXp) pair with multipliers, rounding, and cap.
 * @param {number} level
 * @param {number} inLevelXp
 * @param {number} baseGain
 * @param {{xpMultiplier?:number, globalMultiplier?:number, round?:number, maxLevel?:number}} opts
 * @returns {{level:number,inLevel:number,gained:number,levelsUp:number,capped:boolean}}
 */
function addXp(level, inLevelXp, baseGain, opts = {}) {
  let L = Math.max(1, Math.floor(level || 1));
  let X = Math.max(0, Math.floor(inLevelXp || 0));

  const mult = Math.max(0, Number(opts.xpMultiplier ?? 1)) * Math.max(0, Number(opts.globalMultiplier ?? 1));
  let gain = Math.max(0, Math.floor(Number(baseGain) || 0) * mult);

  const step = Math.max(1, Math.floor(opts.round ?? 1));
  gain = Math.floor(gain / step) * step;

  let remaining = gain;
  let levelsUp = 0;
  const cap = Math.max(0, Math.floor(opts.maxLevel ?? CFG.DEFAULT_MAX_LEVEL)); // 0 = no cap
  let capped = false;

  while (remaining > 0) {
    const need = xpToNext(L) - X;
    if (remaining >= need) {
      remaining -= need;
      L += 1;
      X = 0;
      levelsUp += 1;

      if (cap && L >= cap) {
        L = cap;
        X = Math.min(xpToNext(L) - 1, X);
        capped = true;
        break;
      }
    } else {
      X += remaining;
      remaining = 0;
    }
  }

  return { level: L, inLevel: X, gained: gain, levelsUp, capped };
}

// ---------------- Utilities ----------------
const fmt = (n) => new Intl.NumberFormat().format(Number(n || 0));
function formatLevelLine(level, inLevelXp, opts = {}) {
  const p = makeLevelProgress(level, inLevelXp, opts);
  return `Level **${p.level}** — **${fmt(p.inLevel)} / ${fmt(p.toNext)} XP** (${p.percent}%)\n${p.bar}`;
}

// ---------------- Helpers ----------------
function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, Number(v) || 0)); }
function clampInt(v, lo, hi) { return Math.min(hi, Math.max(lo, Math.floor(Number(v) || 0))); }

// ---------------- Exports ----------------
module.exports = {
  // Tunables
  get BASE_XP() { return CFG.BASE_XP; },
  get XP_ALPHA() { return CFG.XP_ALPHA; },
  get XP_BETA() { return CFG.XP_BETA; },
  get MAX_BAR_SIZE() { return CFG.MAX_BAR_SIZE; },
  get DEFAULT_MAX_LEVEL() { return CFG.DEFAULT_MAX_LEVEL; },
  setConfig,

  // Core math
  xpToNext,           // used across events/commands
  getXPNeeded,        // alias (back-compat)
  totalXpForLevel,
  levelFromTotalXp,

  // Bars + UI
  generateProgressBar,
  makeLevelProgress,
  formatLevelLine,

  // XP Gain
  addXp,
};
