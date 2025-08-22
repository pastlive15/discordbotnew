// commands/emote.js
// /emote emotion:<choice> [user:@target]
// - ใช้ nekos.best + waifu.pics API
// - ปรับข้อความให้เป็นธรรมชาติมากขึ้น
// - ไม่มีปุ่ม "Random again"

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ----- fetch fallback (+timeout) -----
let fetchFn = globalThis.fetch;
try {
  if (typeof fetchFn !== 'function') {
    ({ fetch: fetchFn } = require('undici'));
  }
} catch {
  fetchFn = null;
}

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

// ----- Emote catalog -----
const EMOTE_CHOICES = [
  'angry', 'blush', 'bored', 'cry', 'happy', 'laugh',
  'pout', 'shrug', 'smile', 'think', 'wink', 'yawn', 'sad'
];

// map “sad” → “cry”
const NORMALIZE = { sad: 'cry' };

// look table
const LOOKS = {
  angry: { emoji: '😠', color: 0xE74C3C, self: 'is really angry', target: 'is angry with' },
  blush: { emoji: '😊', color: 0xFADADD, self: 'is blushing', target: 'blushes because of' },
  bored: { emoji: '😑', color: 0x95A5A6, self: 'looks bored', target: 'is bored with' },
  cry:   { emoji: '😭', color: 0x3498DB, self: 'starts crying', target: 'cries because of' },
  happy: { emoji: '😄', color: 0x2ECC71, self: 'looks so happy', target: 'is happy with' },
  laugh: { emoji: '😆', color: 0x1ABC9C, self: 'bursts out laughing', target: 'laughs with' },
  pout:  { emoji: '😾', color: 0x9B59B6, self: 'pouts cutely', target: 'pouts at' },
  shrug: { emoji: '🤷', color: 0xBDC3C7, self: 'shrugs', target: 'shrugs at' },
  smile: { emoji: '🙂', color: 0xF1C40F, self: 'smiles warmly', target: 'smiles at' },
  think: { emoji: '🤔', color: 0x8E44AD, self: 'is deep in thought', target: 'is thinking about' },
  wink:  { emoji: '😉', color: 0xD35400, self: 'winks', target: 'winks at' },
  yawn:  { emoji: '🥱', color: 0x7F8C8D, self: 'yawns', target: 'yawns near' },
  sad:   { emoji: '😢', color: 0x3498DB, self: 'looks sad', target: 'feels sad because of' }
};

// nekos.best categories
const NEKOS_GIF_SET = new Set([
  'angry','blush','bored','cry','happy','laugh','pout','shrug',
  'smile','think','wink','yawn'
]);

// ----- Providers -----
async function getFromNekosBest(kind) {
  const endpoint = `https://nekos.best/api/v2/${encodeURIComponent(kind)}`;
  const res = await fetchWithTimeout(endpoint);
  if (!res.ok) throw new Error(`nekos.best ${res.status}`);
  const data = await res.json();
  const list = data?.results || [];
  return list[Math.floor(Math.random() * Math.max(1, list.length))]?.url || null;
}

async function getFromWaifuPics(kind) {
  const endpoint = `https://api.waifu.pics/sfw/${encodeURIComponent(kind)}`;
  const res = await fetchWithTimeout(endpoint);
  if (!res.ok) throw new Error(`waifu.pics ${res.status}`);
  const data = await res.json();
  return data?.url || null;
}

async function getEmoteGif(emotion) {
  const key = NORMALIZE[emotion] || emotion;

  if (NEKOS_GIF_SET.has(key)) {
    try {
      const url = await getFromNekosBest(key);
      if (url) return url;
    } catch {}
  }
  try {
    const url = await getFromWaifuPics(key);
    if (url) return url;
  } catch {}

  return 'https://i.imgur.com/0Z8FQh8.gif'; // fallback
}

// ----- Command -----
module.exports = {
  name: 'emote',
  description: 'Send an emote GIF (angry, cry, smile, …)',
  data: new SlashCommandBuilder()
    .setName('emote')
    .setDescription('Express an emotion with a GIF')
    .addStringOption(opt =>
      opt.setName('emotion')
        .setDescription('Emotion to express')
        .setRequired(true)
        .addChoices(...EMOTE_CHOICES.map(e => ({ name: e, value: e })))
    )
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('(Optional) Target user')
        .setRequired(false)
    ),

  async execute(interaction) {
    const emotion = interaction.options.getString('emotion');
    const target = interaction.options.getUser('user');
    const who = interaction.user;

    const key = NORMALIZE[emotion] || emotion;
    const look = LOOKS[emotion] || LOOKS[key] || { emoji: '✨', color: 0x5865F2, self: 'shows an emotion', target: 'shows something to' };

    let gif = null;
    try { gif = await getEmoteGif(emotion); } catch {}
    if (!gif) gif = 'https://i.imgur.com/0Z8FQh8.gif';

    const desc = target
      ? `**${who.username}** ${look.target} **${target.username}** ${look.emoji}`
      : `**${who.username}** ${look.self} ${look.emoji}`;

    const embed = new EmbedBuilder()
      .setTitle(`${look.emoji} ${key.charAt(0).toUpperCase() + key.slice(1)}`)
      .setDescription(desc)
      .setImage(gif)
      .setColor(look.color)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
