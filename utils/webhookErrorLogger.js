const { WebhookClient, EmbedBuilder } = require('discord.js');

// Replace this with your actual webhook URL
const WEBHOOK_URL = 'https://discord.com/api/webhooks/1393347120307638465/h11ZqXCuvD5HYDBHMJIVgs5kc5pK76ownKCdRVqv3bI3CnbT1IR-n4T8_tuObmQmLrGS';
const webhook = new WebhookClient({ url: WEBHOOK_URL });

async function sendErrorToWebhook(error, origin = 'Unknown') {
  const embed = new EmbedBuilder()
    .setTitle('🚨 Unhandled Error')
    .setColor('Red')
    .addFields(
      { name: 'Origin', value: `\`${origin}\`` },
      { name: 'Error', value: `\`\`\`${error.stack?.slice(0, 1000) || error.toString()}\`\`\`` }
    )
    .setTimestamp();

  try {
    await webhook.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to send error to webhook:', err);
  }
}

module.exports = { sendErrorToWebhook };
