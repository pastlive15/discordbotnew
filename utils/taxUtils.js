// utils/taxUtils.js
// Lightweight, atomic “bot vault” helpers for taxes & events

const db = require('../db');
const { initUser } = require('./initUser');

const VAULT_ID = 'BOT_BANK';
const VAULT_NAME = 'Bot Vault';

let _ensured = false;

async function ensureVault() {
  if (_ensured) return;
  await initUser({ id: VAULT_ID, username: VAULT_NAME });
  _ensured = true;
}

async function depositTax(amount) {
  const a = Math.floor(Number(amount));
  if (!Number.isFinite(a) || a <= 0) return 0;

  let res = await db.query(
    'UPDATE users SET money = money + $2 WHERE user_id = $1',
    [VAULT_ID, a]
  );
  if (res.rowCount === 0) {
    await ensureVault();
    await db.query('UPDATE users SET money = money + $2 WHERE user_id = $1', [VAULT_ID, a]);
  }
  return a;
}

async function getVaultBalance() {
  const { rows } = await db.query('SELECT money FROM users WHERE user_id = $1', [VAULT_ID]);
  return Number(rows[0]?.money || 0);
}

/**
 * Withdraw up to `amount` atomically with row-level lock.
 * - ล็อกแถวด้วย FOR UPDATE
 * - คำนวณ withdrawn แบบ LEAST(current, amount)
 * - ปรับยอดเป็น GREATEST(current - amount, 0)
 */
async function withdrawFromVault(amount) {
  const want = Math.max(0, Math.floor(Number(amount)));
  if (!Number.isFinite(want) || want <= 0) {
    return { withdrawn: 0, remaining: await getVaultBalance() };
  }

  const execOnce = async () => {
    const { rows } = await db.query(
      `
      WITH cur AS (
        SELECT money::bigint AS money
        FROM users
        WHERE user_id = $1
        FOR UPDATE
      ),
      calc AS (
        SELECT
          COALESCE(money, 0)::bigint AS old_money,
          LEAST(COALESCE(money, 0)::bigint, $2::bigint) AS w
        FROM cur
      ),
      upd AS (
        UPDATE users
        SET money = GREATEST(COALESCE((SELECT old_money FROM calc),0) - (SELECT w FROM calc), 0)
        WHERE user_id = $1
        RETURNING money::bigint AS new_money
      )
      SELECT
        COALESCE((SELECT w FROM calc), 0)::bigint AS withdrawn,
        COALESCE((SELECT new_money FROM upd), (SELECT money FROM cur), 0)::bigint AS remaining;
      `,
      [VAULT_ID, want]
    );
    const r = rows[0] || {};
    return {
      withdrawn: Number(r.withdrawn || 0),
      remaining: Number(r.remaining || 0),
    };
  };

  // ถ้ายังไม่มีแถว BOT_BANK จะได้ remaining=0/withdrawn=0 → ensure แล้วลองใหม่
  let out = await execOnce();
  if (out.withdrawn === 0 && out.remaining === 0) {
    await ensureVault();
    out = await execOnce();
  }
  return out;
}

module.exports = {
  VAULT_ID,
  depositTax,
  getVaultBalance,
  withdrawFromVault,
  ensureVault,
};
