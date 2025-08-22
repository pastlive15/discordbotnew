// deploy-commands.js
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID; // your application (bot) client ID
const guildId = process.env.DEV_GUILD_ID; // optional: deploy to a single test guild

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment.');
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  if (command?.data) {
    commands.push(command.data.toJSON());
  } else {
    console.warn(`⚠️ Skipping ${file} - missing data`);
  }
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    if (guildId) {
      console.log('🚀 Deploying guild slash commands...');
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('✅ Guild commands deployed!');
    } else {
      console.log('🌍 Deploying global slash commands...');
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✅ Global commands deployed!');
    }
  } catch (error) {
    console.error('❌ Failed to deploy commands:', error);
    process.exitCode = 1;
  }
})();
