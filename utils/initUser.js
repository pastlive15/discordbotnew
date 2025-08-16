// utils/initUser.js
// Single-source-of-truth initUser: always UPSERT and return a fresh row.
// Works with an explicit db client OR falls back to the shared pool.

const defaultPool = require('../db');

/**
 * Ensure a user row exists and return it.
 * @param {{id:string, username?:string}} user
 * @param {import('pg').Pool|import('pg').PoolClient} [dbc] optional db override
 */
async function initUser(user, dbc = defaultPool) {
  if (!user || !user.id) return null;

  const userId = String(user.id);               // keep as TEXT (Discord snowflake-safe)
  const username = String(user.username || 'Unknown');

  // If your users.user_id isn't TEXT yet:
  // ALTER TABLE users ALTER COLUMN user_id TYPE TEXT;

  const upsertSQL = `
    INSERT INTO users (
      user_id, username, xp, level, money, bank, bank_limit, job_level,
      last_daily, last_steal, last_vaultrob, xp_multiplier, coin_multiplier,
      interact_count, items, married_to, couple_streak, couple_last_claim, couple_anniv, couple_title
    )
    VALUES (
      $1, $2, 0, 1, 0, 0, 200000, 1,
      0, 0, 0, 1, 1,
      '{}'::jsonb, '{}'::jsonb, NULL, 0, 0, 0, NULL
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
      username = EXCLUDED.username
    RETURNING *;
  `;

  const { rows } = await dbc.query(upsertSQL, [userId, username]);
  return rows[0] || null;
}

/** Helper: ensure + nice error back to the interaction (ephemeral) */
async function ensureUserOrReply(interaction, dbc = defaultPool) {
  const row = await initUser(interaction.user, dbc);
  if (!row) {
    await interaction.reply({ content: '⚠️ Could not initialize your profile. Please try again.', flags: 64 });
    return null;
  }
  return row;
}

module.exports = { initUser, ensureUserOrReply };
