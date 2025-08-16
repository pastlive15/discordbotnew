// utils/adminAuth.js
const path = require('node:path');
const fs = require('node:fs');

let adminIds = [];
try {
  const file = path.join(__dirname, '..', 'config', 'admins.json');
  const raw = fs.readFileSync(file, 'utf8');
  adminIds = JSON.parse(raw);
  if (!Array.isArray(adminIds)) adminIds = [];
} catch (_) {
  adminIds = [];
}

/**
 * @param {string} userId - Discord user ID of the caller
 * @param {string} ownerId - Guild owner ID (optional but recommended)
 * @returns {boolean}
 */
function isAdmin(userId, ownerId) {
  if (!userId) return false;
  // Owner override (remove this line if you do NOT want owners to bypass)
  if (ownerId && userId === ownerId) return true;
  return adminIds.includes(userId);
}

module.exports = { isAdmin, adminIds };
