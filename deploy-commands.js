// deploy-commands.js
// ------------------------------------------------------
// Safe deploy for slash commands (discord.js v14 / REST v10)
// - Loads .env
// - Validates env
// - Auto-detects correct Application ID from the token
// - Loads ./commands/*.js
// - Deploys to guild if DEV_GUILD_ID is set, else global
// ------------------------------------------------------

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

// ---------- ENV ----------
const required = ['DISCORD_TOKEN'];
for (const k of required) {
  if (!process.env[k]) throw new Error(`Missing ${k} in .env`);
}
const { DISCORD_TOKEN } = process.env;

// Optional, used for logs/validation only; we'll auto-fix if wrong.
let ENV_CLIENT_ID = process.env.CLIENT_ID || '';
const DEV_GUILD_ID = process.env.DEV_GUILD_ID || '';

const isSnowflake = (s) => typeof s === 'string' && /^\d{17,20}$/.test(s);

// ---------- LOAD COMMANDS ----------
const commandsDir = path.join(__dirname, 'commands');
if (!fs.existsSync(commandsDir)) {
  throw new Error(`Commands directory not found at: ${commandsDir}`);
}

function loadCommands(dir) {
  const files = fs.readdirSync(dir);
  const out = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      out.push(...loadCommands(full));
      continue;
    }
    if (!file.endsWith('.js') && !file.endsWith('.cjs')) continue;

    const cmd = require(full);
    if (!cmd || !cmd.data || typeof cmd.execute !== 'function') {
      console.warn(`⚠️  Skipped ${file}: missing { data, execute } export`);
      continue;
    }
    let json;
    try {
      json = typeof cmd.data.toJSON === 'function' ? cmd.data.toJSON() : cmd.data;
      if (!json?.name || !json?.description) throw new Error('missing name/description');
    } catch (e) {
      console.warn(`⚠️  Skipped ${file}: invalid SlashCommandBuilder (${e.message})`);
      continue;
    }
    out.push(json);
  }
  return out;
}

const commands = loadCommands(commandsDir);
if (commands.length === 0) {
  console.warn('⚠️  No commands found to deploy.');
}

// ---------- REST ----------
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('[dotenv] .env loaded');

    // 1) Query current application from token (source of truth)
    const app = await rest.get(Routes.currentApplication());
    const appId = app?.id;
    if (!isSnowflake(appId)) {
      throw new Error('Could not resolve application id from token');
    }

    // 2) Warn if .env CLIENT_ID mismatches
    if (ENV_CLIENT_ID && ENV_CLIENT_ID !== appId) {
      console.warn(`⚠️  CLIENT_ID in .env does not match the token's application id.`);
      console.warn(`    .env CLIENT_ID: ${ENV_CLIENT_ID}`);
      console.warn(`    token app.id  : ${appId}`);
      console.warn(`    Using ${appId} for deployment.`);
    }
    if (!ENV_CLIENT_ID) {
      console.log(`ℹ️  Using application id from token: ${appId}`);
    }
    const CLIENT_ID = appId;

    // 3) Validate DEV_GUILD_ID (if present)
    if (DEV_GUILD_ID && !isSnowflake(DEV_GUILD_ID)) {
      throw new Error(`DEV_GUILD_ID must be a numeric snowflake. Got: "${DEV_GUILD_ID}"`);
    }

    // 4) Deploy
    if (DEV_GUILD_ID) {
      console.log('🚀 Deploying GUILD slash commands...');
      const data = await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID),
        { body: commands },
      );
      console.log(`✅ Deployed ${Array.isArray(data) ? data.length : 0} guild commands to ${DEV_GUILD_ID}.`);
      console.log('🔗 Tip: guild deploy shows instantly. If you don’t see them, check the bot is in the guild.');
    } else {
      console.log('🚀 Deploying GLOBAL slash commands...');
      const data = await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commands },
      );
      console.log(`✅ Deployed ${Array.isArray(data) ? data.length : 0} global commands.`);
      console.log('ℹ️  Global commands can take up to ~1 hour to propagate.');
    }
  } catch (err) {
    console.error('❌ Failed to deploy commands:', err);

    const code = err?.code ?? err?.rawError?.code;
    if (code === 10002) {
      console.error('💡 Unknown Application: โทเค็นนี้ไม่ตรงกับ CLIENT_ID ก่อนหน้า, หรือใช้โทเค็นผิดแอป.');
      console.error('   - ใช้สคริปต์นี้แล้วจะอ้างอิง app.id จากโทเค็นให้เอง');
      console.error('   - หากยังพัง: รีเจนบอทโทเค็นใน Developer Portal และอัปเดต .env');
    }
    if (code === 50035) {
      console.error('💡 Invalid Form Body: ตรวจว่า CLIENT_ID/DEV_GUILD_ID เป็นตัวเลขล้วน (snowflake)');
    }
    if (String(err?.status) === '401') {
      console.error('💡 Unauthorized: โทเค็นผิด/หมดอายุ');
    }
    process.exitCode = 1;
  }
})();
