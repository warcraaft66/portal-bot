const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const WORKER_URL     = process.env.WORKER_URL;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
});

async function getLeaderboardRank(userId) {
  try {
    const res = await fetch(`${WORKER_URL}/leaderboard`);
    const data = await res.json();
    if (!data.entries || !data.entries.length) return null;
    // FIX: rank is based on combined time, matching the worker sort
    const sorted = [...data.entries].sort((a, b) => (b.totalMins + b.watchMins) - (a.totalMins + a.watchMins));
    const rank = sorted.findIndex(e => e.userId === userId);
    if (rank === -1) return null;
    return { rank: rank + 1, total: sorted.length };
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

  console.log(`Message received: "${cmd}" from ${user.username}`);

  // ── CLOCK IN ──
  if (cmd === '!clockin') {
    console.log(`Clocking in ${user.username}`);
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
      console.log('Clockin response:', JSON.stringify(data));

      if (data.alreadyClockedIn) {
        const embed = new EmbedBuilder()
          .setColor(0xf5c842)
          .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
          .setTitle('⚠️ Already Clocked In')
          .setDescription('You are already clocked in. Use `!clockout` to stop your session.')
          .setTimestamp();
        return message.reply({ embeds: [embed] });
      }

      const rank = await getLeaderboardRank(user.id);
      const embed = new EmbedBuilder()
        .setColor(0x00c864)
        .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
        .setTitle('✅ Successfully Clocked In')
        .setDescription('Your training session has started. Type `!clockout` when you\'re done.')
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
    console.log(`Clocking out ${user.username}`);
    try {
      const res = await fetch(`${WORKER_URL}/clockout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await res.json();
      console.log('Clockout response:', JSON.stringify(data));

      if (!data.wasClockedIn) {
        const embed = new EmbedBuilder()
          .setColor(0xff4455)
          .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
          .setTitle('❌ Not Clocked In')
          .setDescription('You weren\'t clocked in. Use `!clockin` to start a session.')
          .setTimestamp();
        return message.reply({ embeds: [embed] });
      }

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
      const res = await fetch(`${WORKER_URL}/leaderboard`);
      const data = await res.json();

      if (!data.entries || !data.entries.length) {
        return message.reply('No data yet — be the first to `!clockin`!');
      }

      const medals = ['🥇', '🥈', '🥉'];
      // FIX: show combined totalMins + watchMins
      const lines = data.entries
        .slice(0, 10)
        .map((e, i) => {
          const combined = (e.totalMins || 0) + (e.watchMins || 0);
          return `${medals[i] || `${i + 1}.`} **${e.globalName || e.username}** — ${formatMins(combined)}${e.clockedIn ? ' 🟢' : ''}`;
        });

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

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId     = newState.member?.id || oldState.member?.id;
  const username   = newState.member?.user?.username || oldState.member?.user?.username;
  const globalName = newState.member?.user?.globalName || username;
  const avatar     = newState.member?.user?.avatar
    ? `https://cdn.discordapp.com/avatars/${userId}/${newState.member.user.avatar}.png` : null;

  if (!userId) return;

  const channelId   = newState.channelId;
  const isStreaming = newState.streaming;
  const isVideo     = newState.selfVideo;
  const channelName = newState.channel?.name || null;

  if (!oldState.channelId && newState.channelId) {
    await postVoiceState({ userId, username, globalName, avatar, channelId, channelName, streaming: isStreaming, video: isVideo, action: 'join' });
  } else if (oldState.channelId && !newState.channelId) {
    await postVoiceState({ userId, username, globalName, avatar, channelId: null, channelName: null, streaming: false, video: false, action: 'leave' });
  } else if (newState.channelId) {
    await postVoiceState({ userId, username, globalName, avatar, channelId, channelName, streaming: isStreaming, video: isVideo, action: 'update' });
  }
});

async function postVoiceState(payload) {
  try {
    await fetch(`${WORKER_URL}/voice-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { console.error('Voice state error:', e); }
}

async function syncVoiceSnapshot() {
  try {
    const guilds = client.guilds.cache;
    const members = [];
    guilds.forEach(guild => {
      guild.voiceStates.cache.forEach((vs) => {
        if (!vs.channelId) return;
        members.push({
          userId:      vs.member?.id,
          username:    vs.member?.user?.username,
          globalName:  vs.member?.user?.globalName || vs.member?.user?.username,
          avatar:      vs.member?.user?.avatar ? `https://cdn.discordapp.com/avatars/${vs.member.id}/${vs.member.user.avatar}.png` : null,
          channelId:   vs.channelId,
          channelName: vs.channel?.name || null,
          streaming:   vs.streaming,
          video:       vs.selfVideo,
        });
      });
    });
    await fetch(`${WORKER_URL}/voice-snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members }),
    });
  } catch (e) { console.error('Snapshot sync failed:', e); }
}

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot ready as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: '!clockin / !clockout', type: 2 }],
    status: 'online',
  });
  setInterval(syncVoiceSnapshot, 30000);
  syncVoiceSnapshot();
});

client.login(process.env.DISCORD_TOKEN);
