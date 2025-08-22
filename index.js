// index.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  Collection,
  REST,
  Routes,
} = require('discord.js');

const db = require('./db');
const { sendErrorToWebhook } = require('./utils/webhookErrorLogger');
const logger = require('./utils/logger');

// ---------- Global process guards ----------
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  sendErrorToWebhook(error, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  sendErrorToWebhook(reason, 'unhandledRejection');
});

// ---------- Client ----------
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
bot.commands = new Collection();

// ---------- Optional: quick DB smoke test ----------
(async () => {
  try {
    await db.query('SELECT NOW()');
    console.log('🟢 Connected to PostgreSQL database');
  } catch (err) {
    console.error('🔴 Failed to connect to PostgreSQL database:', err);
  }
})();

// ---------- Loaders ----------
function loadCommands() {
  const commandsPath = path.join(__dirname, 'commands');
  if (!fs.existsSync(commandsPath)) return;

  const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  const seen = new Set();
  for (const file of files) {
    const full = path.join(commandsPath, file);
    try {
      const cmd = require(full);

      // #ไทย: ต้องมี name และ data (SlashCommandBuilder)
      if (!cmd?.name || !cmd?.data) {
        console.warn(`⚠️ Skipping ${file}: missing "name" or "data".`);
        continue;
      }

      if (seen.has(cmd.name)) {
        console.warn(`⚠️ Duplicate command name "${cmd.name}" in ${file}. Skipped.`);
        continue;
      }

      bot.commands.set(cmd.name, cmd);
      seen.add(cmd.name);
    } catch (e) {
      console.error(`❌ Failed loading command ${file}:`, e);
    }
  }

  console.log(`🧩 Loaded ${bot.commands.size} command(s).`);
}

function loadEvents() {
  const eventsPath = path.join(__dirname, 'events');
  if (!fs.existsSync(eventsPath)) return;

  const files = fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'));

  for (const file of files) {
    const full = path.join(eventsPath, file);
    try {
      const evt = require(full);
      if (!evt?.name || typeof evt.execute !== 'function') {
        console.warn(`⚠️ Skipping event ${file}: missing "name" or "execute".`);
        continue;
      }
      // #ไทย: listener ทุกอีเวนต์จะถูก bind พร้อมส่ง bot, db ต่อท้ายพารามิเตอร์
      bot.on(evt.name, (...args) => evt.execute(...args, bot, db));
    } catch (e) {
      console.error(`❌ Failed loading event ${file}:`, e);
    }
  }

  console.log(`🎧 Loaded ${files.length} event file(s).`);
}

// ---------- Slash registration ----------
async function registerSlashCommands() {
  // #ไทย: ใช้ command.data.toJSON() เพื่อเก็บ options/subcommands ครบถ้วน
  const payload = bot.commands.map((c) => {
    try {
      return c.data.toJSON();
    } catch (e) {
      console.error(`❌ toJSON failed for /${c.name}:`, e);
      return null;
    }
  }).filter(Boolean);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const appId = bot.user.id;
  const devGuildId = process.env.DEV_GUILD_ID;

  try {
    if (devGuildId) {
      // #ไทย: โหมด Dev ลงเฉพาะกิลด์ (deploy เร็ว)
      await rest.put(Routes.applicationGuildCommands(appId, devGuildId), { body: payload });
      console.log(`✅ Registered ${payload.length} guild (dev) commands for G:${devGuildId}`);
    } else {
      // #ไทย: โปรดักชัน ลง global (อาจใช้เวลาหลายนาที)
      await rest.put(Routes.applicationCommands(appId), { body: payload });
      console.log(`✅ Registered ${payload.length} global slash commands`);
    }
  } catch (err) {
    console.error('❌ Slash registration failed:', err?.stack || err);
    sendErrorToWebhook(err, 'slashRegistration');
  }
}

// ---------- Rate limit/log hooks (optional but useful) ----------
bot.rest?.on?.('rateLimited', (info) => {
  console.warn('⚠️ REST rate limited:', info);
});

// ---------- Ready ----------
bot.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${bot.user.tag}`);

  // #ไทย: โหลดคำสั่งและอีเวนต์ก่อน แล้วค่อยลงทะเบียน slash
  loadCommands();
  loadEvents();
  await registerSlashCommands();

  console.log('🚀 Bot is ready.');
});

// ---------- Graceful shutdown ----------
async function gracefulExit(signal) {
  try {
    console.log(`📴 Received ${signal}. Shutting down...`);
    await bot.destroy();
  } catch (e) {
    console.warn('Shutdown error:', e);
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

// ---------- Login ----------
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is missing in .env');
  process.exit(1);
}
bot.login(process.env.DISCORD_TOKEN);
