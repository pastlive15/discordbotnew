const { WebhookClient, EmbedBuilder } = require('discord.js');

const WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
let webhook = null;
if (WEBHOOK_URL && /^https:\/\/discord.com\/api\/webhooks\//.test(WEBHOOK_URL)) {
  webhook = new WebhookClient({ url: WEBHOOK_URL });
} else {
  console.warn('[warn] ERROR_WEBHOOK_URL is not set or invalid; error webhook disabled.');
}

async function sendErrorToWebhook(error, origin = 'Unknown') {
  if (!webhook) return;
  const embed = new EmbedBuilder()
    .setTitle('🚨 Unhandled Error')
    .setColor('Red')
    .addFields(
      { name: 'Origin', value: `\`${origin}\`` },
      { name: 'Error', value: `\`\`\`${(error && error.stack ? String(error.stack).slice(0, 1900) : String(error)).slice(0, 1900)}\`\`\`` }
    )
    .setTimestamp();

  try {
    await webhook.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to send error to webhook:', err);
  }
}

module.exports = { sendErrorToWebhook };
