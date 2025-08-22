// commands/interact.js
// PostgreSQL-compatible Interact Command using nekos.best for GIFs,
// with waifu.pics fallback for actions nekos.best doesn't support (lick, boop->poke)
//
// #คอมเมนต์(TH):
// - แก้ให้ reply คืน Message ด้วย fetchReply:true (ไม่งั้น collector ผูกกับ msg ไม่ได้)
// - เสริม fallback ให้ fetch (ใช้ undici ถ้าไม่มี global fetch) และใส่ timeout กันค้าง
// - ปรับ collector filter ให้เฉพาะ target กดได้ + จำกัดปุ่มทำงานครั้งเดียว

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType
} = require('discord.js');
const { initUser } = require('../utils/initUser');

// ----- fetch fallback (+timeout helper) -----
let fetchFn = globalThis.fetch;
try {
  if (typeof fetchFn !== 'function') {
    // #หมายเหตุ: ถ้า Node < 18 ให้ติดตั้ง undici ใน package.json
    // npm i undici
    ({ fetch: fetchFn } = require('undici'));
  }
} catch {
  // ถ้าไม่มีจริง ๆ จะพังเป็น fallback gif ด้านล่าง
  fetchFn = null;
}

// timeout wrapper
async function fetchWithTimeout(url, opts = {}, ms = 8_000) {
  if (!fetchFn) throw new Error('fetch unavailable');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetchFn(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// Actions map (colors/emojis/text). GIFs are fetched at runtime.
const actions = {
  hug:      { label: 'hugged',         marriedLabel: 'shared a heartfelt hug with',       color: 0xFFC0CB, emoji: '🤗' },
  kiss:     { label: 'kissed',         marriedLabel: 'gently kissed their beloved',       color: 0xFF69B4, emoji: '💋' },
  pat:      { label: 'patted',         marriedLabel: 'lovingly patted',                   color: 0xADD8E6, emoji: '🫳' },
  slap:     { label: 'slapped',        marriedLabel: 'playfully slapped',                 color: 0xFF6347, emoji: '🖐️' },
  poke:     { label: 'poked',          marriedLabel: 'lightly poked',                     color: 0xFFFF99, emoji: '👉' },
  cuddle:   { label: 'cuddled',        marriedLabel: 'snuggled warmly with their soulmate', color: 0xE6E6FA, emoji: '🧸' },
  bite:     { label: 'bit',            marriedLabel: 'gently bit their partner',          color: 0xD2691E, emoji: '🦷' },
  boop:     { label: 'booped',         marriedLabel: 'booped lovingly',                   color: 0xFADADD, emoji: '🐽' },
  highfive: { label: 'high-fived',     marriedLabel: 'energetically high-fived',          color: 0xFFD700, emoji: '✋' },
  lick:     { label: 'licked',         marriedLabel: 'licked their partner playfully',    color: 0xFFB6C1, emoji: '👅' },
  wave:     { label: 'waved at',       marriedLabel: 'greeted their beloved with a wave', color: 0x87CEFA, emoji: '👋' }
};

// Actions supported by nekos.best directly
const NEKOS_BEST_ACTIONS = new Set([
  'hug', 'kiss', 'pat', 'slap', 'poke', 'cuddle', 'bite', 'highfive', 'wave'
]);

// --- Providers ---
async function getGifFromNekosBest(actionKey) {
  const endpoint = `https://nekos.best/api/v2/${encodeURIComponent(actionKey)}`;
  const res = await fetchWithTimeout(endpoint);
  if (!res.ok) throw new Error(`nekos.best error ${res.status}`);
  const data = await res.json();
  const list = data?.results || [];
  return list[Math.floor(Math.random() * Math.max(1, list.length))]?.url || null;
}

async function getGifFromWaifuPics(path) {
  const endpoint = `https://api.waifu.pics/sfw/${encodeURIComponent(path)}`;
  const res = await fetchWithTimeout(endpoint);
  if (!res.ok) throw new Error(`waifu.pics error ${res.status}`);
  const data = await res.json();
  return data?.url || null;
}

// Centralized GIF fetcher (with fallbacks)
async function getInteractionGif(actionKey) {
  // 1) nekos.best for supported actions
  if (NEKOS_BEST_ACTIONS.has(actionKey)) {
    try {
      const url = await getGifFromNekosBest(actionKey);
      if (url) return url;
    } catch {}
  }

  // 2) waifu.pics for special cases
  if (actionKey === 'lick') {
    try {
      const url = await getGifFromWaifuPics('lick');
      if (url) return url;
    } catch {}
  }
  if (actionKey === 'boop') {
    // treat boop ≈ poke
    try {
      const url = await getGifFromWaifuPics('poke');
      if (url) return url;
    } catch {}
  }

  // 3) static fallbacks
  const fallback = {
    hug: 'https://media.tenor.com/qsF3aQ5B8HkAAAAC/cute-hug.gif',
    pat: 'https://media.tenor.com/w3m1yyl5kKkAAAAC/pat-pat-anime.gif',
    slap: 'https://media.tenor.com/4kKfH8n6s7QAAAAC/anime-slap.gif',
    lick: 'https://media.tenor.com/8NTaWRczXkcAAAAC/anime-lick.gif',
    boop: 'https://media.tenor.com/pgs74RSq8XsAAAAC/boop-anime.gif'
  }[actionKey];

  return fallback || 'https://i.imgur.com/0Z8FQh8.gif';
}

module.exports = {
  name: 'interact',
  description: 'Send an interaction (hug, kiss, pat, etc.) to another user!',
  data: new SlashCommandBuilder()
    .setName('interact')
    .setDescription('Interact with someone')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('The type of interaction')
        .setRequired(true)
        .addChoices(...Object.keys(actions).map(key => ({ name: key, value: key })))
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The person you want to interact with')
        .setRequired(true)
    ),

  async execute(interaction, db) {
    const actionKey = interaction.options.getString('action');
    const target = interaction.options.getUser('user');
    const sender = interaction.user;
    const action = actions[actionKey];

    // #Guard พื้นฐาน
    if (!action || target.id === sender.id || target.bot) {
      return interaction.reply({ content: '❌ Invalid action or target.', ephemeral: true });
    }

    // Ensure rows exist
    await initUser(sender);
    await initUser(target);

    const senderData = await db.query('SELECT married_to FROM users WHERE user_id = $1', [sender.id]);
    const isMarried = senderData.rows[0]?.married_to === target.id;

    // Fetch GIF with fallback chain
    let gif = null;
    try { gif = await getInteractionGif(actionKey); } catch {}
    if (!gif) gif = 'https://i.imgur.com/0Z8FQh8.gif';

    const text = isMarried
      ? `${sender.username} ${action.marriedLabel} ${target.username}!`
      : `${sender.username} ${action.label} ${target.username}!`;

    const embed = new EmbedBuilder()
      .setTitle(`${action.emoji} Interaction`)
      .setDescription(text)
      .setImage(gif)
      .setColor(action.color)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`interact_back_${actionKey}`)
        .setLabel(`${action.emoji} ${actionKey.charAt(0).toUpperCase() + actionKey.slice(1)} Back`)
        .setStyle(ButtonStyle.Secondary)
    );

    // #สำคัญ: ต้องใส่ fetchReply:true เพื่อให้ได้ Message กลับมา
    const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });

    // Safely increment JSONB counter
    await db.query(
      `UPDATE users
       SET interact_count = jsonb_set(
         COALESCE(interact_count, '{}'::jsonb),
         $1::text[],
         (COALESCE((interact_count ->> $2)::int, 0) + 1)::text::jsonb,
         true
       )
       WHERE user_id = $3`,
      [[actionKey], actionKey, sender.id]
    );

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 1_200_000,
      max: 1, // #ให้ปุ่มทำงานได้ครั้งเดียว
      filter: (btn) =>
        btn.customId === `interact_back_${actionKey}` && btn.user.id === target.id,
    });

    collector.on('collect', async (btn) => {
      // Fetch a new gif for the return interaction
      let replyGif = null;
      try { replyGif = await getInteractionGif(actionKey); } catch {}
      if (!replyGif) replyGif = gif;

      const replyEmbed = new EmbedBuilder()
        .setTitle(`${action.emoji} Interaction Returned`)
        .setDescription(`${target.username} ${action.label} back ${sender.username}!`)
        .setImage(replyGif)
        .setColor(action.color)
        .setTimestamp();

      await btn.reply({ embeds: [replyEmbed] });

      await db.query(
        `UPDATE users
         SET interact_count = jsonb_set(
           COALESCE(interact_count, '{}'::jsonb),
           $1::text[],
           (COALESCE((interact_count ->> $2)::int, 0) + 1)::text::jsonb,
           true
         )
         WHERE user_id = $3`,
        [[`${actionKey}Returned`], `${actionKey}Returned`, target.id]
      );
    });

    // (ออปชัน) จะ disable ปุ่มหลังหมดเวลาได้ แต่ไม่จำเป็นเพราะ msg ปัจจุบันไม่มีปุ่มอื่นซ้ำ
    collector.on('end', async () => {
      try {
        await msg.edit({ components: [] });
      } catch {}
    });
  }
};
