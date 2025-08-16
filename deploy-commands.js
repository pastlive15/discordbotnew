const { REST, Routes } = require('discord.js');
const { clientId, token } = require('./config.json'); // or process.env

const commands = [];
const fs = require('node:fs');
const path = require('node:path');

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  if (command.data) {
    commands.push(command.data.toJSON());
  } else {
    console.warn(`⚠️ Skipping ${file} - missing data`);
  }
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('🌍 Deploying global slash commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Commands deployed globally!');
  } catch (error) {
    console.error('❌ Failed to deploy commands:', error);
  }
})();
