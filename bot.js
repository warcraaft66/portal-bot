// ─── PORTAL Discord Bot ───
// Env vars: DISCORD_TOKEN, WORKER_URL, GUILD_ID, LOG_CHANNEL_ID (optional)

const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const WORKER_URL       = process.env.WORKER_URL;
const GUILD_ID         = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const LOG_CHANNEL_ID   = process.env.LOG_CHANNEL_ID;

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

// ─── HELPER: get leaderboard rank for a user ───
async function getLeaderboardRank(userId) {
  try {
    const res = await fetch(`${WORKER_URL}/leaderboard`);
    const data = await res.json();
    if (!data.entries || !data.entries.length) return null;
    const rank = data.entries.findIndex(e => e.userId === userId);
    if (rank === -1) return null;
    return { rank: rank + 1, total: data.entries.length };
  } catch {
    return null;
  }
}

function rankLabel(rank) {
  if (!rank) return '—';
  const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const suffix = rank.rank <= 3 ? medals[rank.rank] : `#${rank.rank}`;
  return `${suffix} of ${rank.total}`;
}

// ─── CLOCK IN / OUT ───
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.guildId !== GUILD_ID) return;

  const cmd = message.content.trim().toLowerCase();
  const user = message.author;

  // ── CLOCK IN ──
  if (cmd === '!clockin' || cmd === 'clock in') {
    const res = await fetch(`${WORKER_URL}/clockin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        username: user.username,
        globalName: user.globalName || user.username,
        avatar: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
          : null,
      }),
    });
    const data = await res.json();

    if (data.alreadyClockedIn) {
      const embed = new EmbedBuilder()
        .setColor(0xf5c842)
        .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
        .setTitle('⚠️ Already Clocked In')
        .setDescription('You are already clocked in. Use `!clockout` to stop your session.')
        .setTimestamp();
      return message.reply({ embeds: [embed] });
    }

    // Fetch rank after clocking in
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

    message.reply({ embeds: [embed] });
    postToLogChannel(message.guild, embed);
  }

  // ── CLOCK OUT ──
  if (cmd === '!clockout' || cmd === 'clock out') {
    const res = await fetch(`${WORKER_URL}/clockout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id }),
    });
    const data = await res.json();

    if (!data.wasClockedIn) {
      const embed = new EmbedBuilder()
        .setColor(0xff4455)
        .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
        .setTitle('❌ Not Clocked In')
        .setDescription('You weren\'t clocked in. Use `!clockin` to start a session.')
        .setTimestamp();
      return message.reply({ embeds: [embed] });
    }

    // Fetch rank after clocking out (totals now updated)
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

    message.reply({ embeds: [embed] });
    postToLogChannel(message.guild, embed);
  }

  // ── MY TIME ──
  if (cmd === '!mytime') {
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

    message.reply({ embeds: [embed] });
  }

  // ── LEADERBOARD ──
  if (cmd === '!leaderboard') {
    const res = await fetch(`${WORKER_URL}/leaderboard`);
    const data = await res.json();

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

    message.reply({ embeds: [embed] });
  }
});

// ─── POST TO LOG CHANNEL ───
async function postToLogChannel(guild, embed) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (channel) channel.send({ embeds: [embed] });
  } catch {}
}

// ─── VOICE STATE TRACKING ───
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId     = newState.member?.id || oldState.member?.id;
  const username   = newState.member?.user?.username || oldState.member?.user?.username;
  const globalName = newState.member?.user?.globalName || username;
  const avatar     = newState.member?.user?.avatar
    ? `https://cdn.discordapp.com/avatars/${userId}/${newState.member.user.avatar}.png`
    : null;

  if (!userId) return;

  const channelId   = newState.channelId;
  const isStreaming = newState.streaming;
  const isVideo     = newState.selfVideo;
  const channelName = newState.channel?.name || null;

  if (VOICE_CHANNEL_ID && channelId && channelId !== VOICE_CHANNEL_ID) return;

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
  } catch (e) {
    console.error('Failed to post voice state:', e);
  }
}

// ─── PERIODIC VOICE SNAPSHOT ───
async function syncVoiceSnapshot() {
  try {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;

    const members = [];
    guild.voiceStates.cache.forEach((vs) => {
      if (!vs.channelId) return;
      if (VOICE_CHANNEL_ID && vs.channelId !== VOICE_CHANNEL_ID) return;
      members.push({
        userId:      vs.member?.id,
        username:    vs.member?.user?.username,
        globalName:  vs.member?.user?.globalName || vs.member?.user?.username,
        avatar:      vs.member?.user?.avatar
          ? `https://cdn.discordapp.com/avatars/${vs.member.id}/${vs.member.user.avatar}.png`
          : null,
        channelId:   vs.channelId,
        channelName: vs.channel?.name || null,
        streaming:   vs.streaming,
        video:       vs.selfVideo,
      });
    });

    await fetch(`${WORKER_URL}/voice-snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members }),
    });
  } catch (e) {
    console.error('Snapshot sync failed:', e);
  }
}

// ─── BOT READY ───
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

// ─── HELPERS ───
function formatMins(mins) {
  if (!mins || mins < 1) return '0 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
