// commands/debug.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const os = require('os');
const fs = require('fs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readCpuTimes() {
  const cpus = os.cpus();
  const sum = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
  for (const c of cpus) {
    sum.user += c.times.user;
    sum.nice += c.times.nice;
    sum.sys  += c.times.sys;
    sum.idle += c.times.idle;
    sum.irq  += c.times.irq;
  }
  return sum;
}

async function sampleCpuUsage(ms = 500) {
  const a = readCpuTimes();
  await sleep(ms);
  const b = readCpuTimes();
  const delta = {
    user: b.user - a.user,
    nice: b.nice - a.nice,
    sys:  b.sys - a.sys,
    idle: b.idle - a.idle,
    irq:  b.irq - a.irq,
  };
  const total = Object.values(delta).reduce((s,v)=>s+v,0) || 1;
  const pct = (n)=>100*n/total;
  return {
    total: 100 - pct(delta.idle),
    user: pct(delta.user),
    system: pct(delta.sys),
    nice: pct(delta.nice),
    irq: pct(delta.irq),
    idle: pct(delta.idle),
  };
}

function bytesFmt(n) {
  const units = ['B','KB','MB','GB','TB'];
  let i=0, v=n;
  while(v>=1024 && i<units.length-1){ v/=1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function readSwapLinux() {
  try {
    const txt = fs.readFileSync('/proc/meminfo','utf8');
    const get = (k)=> {
      const m = txt.match(new RegExp(`^${k}:\\s+(\\d+) kB`,'m'));
      return m ? parseInt(m[1])*1024 : 0;
    };
    const total = get('SwapTotal'), free = get('SwapFree');
    return { used: total-free, total };
  } catch { return { used:0,total:0 }; }
}

module.exports = {
  name: 'debug',
  description: 'Show CPU, memory, and system stats',
  data: new SlashCommandBuilder().setName('debug').setDescription('Show system resource usage'),
  async execute(interaction) {
    const cpu = await sampleCpuUsage(500);

    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();
    const swap = process.platform==='linux' ? readSwapLinux() : {used:0,total:0};

    const cpuModel = os.cpus()[0]?.model || 'Unknown CPU';
    const osName = process.platform==='win32'
      ? `Windows ${os.release()}`
      : `${os.type()} ${os.release()}`;

    const desc =
`${osName}
${cpuModel}
CPU: ${cpu.total.toFixed(0)}%
(User ${cpu.user.toFixed(0)}% / System ${cpu.system.toFixed(0)}% / Nice ${cpu.nice.toFixed(0)}% / Interrupt ${cpu.irq.toFixed(0)}% / Idle ${cpu.idle.toFixed(0)}%)
Memory: ${bytesFmt(usedMem)} Used / ${bytesFmt(totalMem)} (Swap: ${bytesFmt(swap.used)} Used / ${bytesFmt(swap.total)})`;

    const embed = new EmbedBuilder()
      .setTitle('🔧 Debug')
      .setColor(0x5865F2)
      .setDescription(desc)
      .setTimestamp();

    // ✅ reply แบบ public ทุกคนเห็น
    return interaction.reply({ embeds:[embed] });
  }
};
