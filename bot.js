const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const WORKER_URL     = process.env.WORKER_URL;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// In-memory leaderboard cache — 5 min TTL
let cachedLeaderboard = null;
let cachedLeaderboardAt = 0;
const LB_CACHE_TTL = 5 * 60 * 1000;

async function getLeaderboard() {
  const now = Date.now();
  if (cachedLeaderboard && now - cachedLeaderboardAt < LB_CACHE_TTL) return cachedLeaderboard;
  const res = await fetch(`${WORKER_URL}/leaderboard`);
  const data = await res.json();
  cachedLeaderboard = data;
  cachedLeaderboardAt = now;
  return data;
}

function bustLocalLbCache() {
  cachedLeaderboard = null;
  cachedLeaderboardAt = 0;
}

async function getLeaderboardRank(userId) {
  try {
    const data = await getLeaderboard();
    if (!data.entries || !data.entries.length) return null;
    const rank = data.entries.findIndex(e => e.userId === userId);
    if (rank === -1) return null;
    return { rank: rank + 1, total: data.entries.length };
  } catch (e) {
    console.error('getLeaderboardRank error:', e);
    return null;
  }
}

function rankLabel(rank) {
  if (!rank) return '—';
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const suffix = rank.rank <= 3 ? medals[rank.rank] : `#${rank.rank}`;
  return `${suffix} of ${rank.total}`;
}

function formatMins(mins) {
  if (!mins || mins < 1) return '0 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const cmd = message.content.trim().toLowerCase();
  const user = message.author;

  // ── CLOCK IN ──
  if (cmd === '!clockin') {
    try {
      const res = await fetch(`${WORKER_URL}/clockin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          username: user.username,
          globalName: user.globalName || user.username,
          avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
        }),
      });
      const data = await res.json();

      if (data.alreadyClockedIn) {
        return message.reply({ embeds: [
          new EmbedBuilder()
            .setColor(0xf5c842)
            .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
            .setTitle('⚠️ Already Clocked In')
            .setDescription('You are already clocked in. Use `!clockout` to stop your session.')
            .setTimestamp()
        ]});
      }

      const rank = await getLeaderboardRank(user.id);
      const embed = new EmbedBuilder()
        .setColor(0x00c864)
        .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
        .setTitle('✅ Clocked In')
        .setDescription('Session started. Type `!clockout` when you\'re done.')
        .addFields(
          { name: '📊 All-Time Total', value: formatMins(data.previousTotal), inline: true },
          { name: '🏆 Leaderboard Rank', value: rankLabel(rank), inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'PORTAL · Training Tracker' });

      await message.reply({ embeds: [embed] });
      postToLogChannel(message.guild, embed);
    } catch (e) {
      console.error('Clockin error:', e);
      message.reply('Something went wrong. Check the logs.');
    }
  }

  // ── CLOCK OUT ──
  if (cmd === '!clockout') {
    try {
      const res = await fetch(`${WORKER_URL}/clockout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json();

      if (!data.wasClockedIn) {
        return message.reply({ embeds: [
          new EmbedBuilder()
            .setColor(0xff4455)
            .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
            .setTitle('❌ Not Clocked In')
            .setDescription('You weren\'t clocked in. Use `!clockin` to start a session.')
            .setTimestamp()
        ]});
      }

      bustLocalLbCache();
      const rank = await getLeaderboardRank(user.id);

      const embed = new EmbedBuilder()
        .setColor(0xd4001a)
        .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
        .setTitle('🏁 Clocked Out')
        .setDescription('Session ended. Great work!')
        .addFields(
          { name: '⏱ This Session', value: formatMins(data.sessionMins), inline: true },
          { name: '📊 All-Time Total', value: formatMins(data.totalMins), inline: true },
          { name: '🏆 Leaderboard Rank', value: rankLabel(rank), inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'PORTAL · Training Tracker' });

      await message.reply({ embeds: [embed] });
      postToLogChannel(message.guild, embed);
    } catch (e) {
      console.error('Clockout error:', e);
      message.reply('Something went wrong. Check the logs.');
    }
  }

  // ── MY TIME ──
  if (cmd === '!mytime') {
    try {
      const res = await fetch(`${WORKER_URL}/clock-history?userId=${user.id}`);
      const data = await res.json();
      const rank = await getLeaderboardRank(user.id);

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
        .setTitle('📊 Your Training Time')
        .addFields(
          { name: '⏳ All-Time Total', value: formatMins(data.totalMins), inline: true },
          { name: '🟢 Status', value: data.clockedIn ? `Clocked in (${formatMins(data.liveMins)} this session)` : 'Not clocked in', inline: true },
          { name: '🏆 Leaderboard Rank', value: rankLabel(rank), inline: true },
        )
        .setTimestamp()
        .setFooter({ text: 'PORTAL · Training Tracker' });

      await message.reply({ embeds: [embed] });
    } catch (e) {
      console.error('Mytime error:', e);
      message.reply('Something went wrong. Check the logs.');
    }
  }

  // ── LEADERBOARD ──
  if (cmd === '!leaderboard') {
    try {
      bustLocalLbCache();
      const data = await getLeaderboard();

      if (!data.entries || !data.entries.length) {
        return message.reply('No data yet — be the first to `!clockin`!');
      }

      const medals = ['🥇', '🥈', '🥉'];
      const lines = data.entries
        .slice(0, 10)
        .map((e, i) => `${medals[i] || `${i + 1}.`} **${e.globalName || e.username}** — ${formatMins(e.totalMins)}${e.clockedIn ? ' 🟢' : ''}`);

      const embed = new EmbedBuilder()
        .setColor(0xf5c842)
        .setTitle('🏆 Training Leaderboard')
        .setDescription(lines.join('\n'))
        .setTimestamp()
        .setFooter({ text: 'PORTAL · Training Tracker · 🟢 = currently clocked in' });

      await message.reply({ embeds: [embed] });
    } catch (e) {
      console.error('Leaderboard error:', e);
      message.reply('Something went wrong. Check the logs.');
    }
  }
});

async function postToLogChannel(guild, embed) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (channel) channel.send({ embeds: [embed] });
  } catch {}
}

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot ready as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: '!clockin / !clockout', type: 2 }],
    status: 'online',
  });
});

client.login(process.env.DISCORD_TOKEN);
