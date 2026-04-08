// ─── PORTAL Discord Bot ───
// npm install discord.js node-fetch
// Set env vars: DISCORD_TOKEN, WORKER_URL, GUILD_ID, VOICE_CHANNEL_ID (optional: specific channel to watch)

const { Client, GatewayIntentBits, Events } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const WORKER_URL       = process.env.WORKER_URL;       // e.g. https://dry-snowflake-f0e8...workers.dev
const GUILD_ID         = process.env.GUILD_ID;         // your Discord server ID
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID; // optional: only watch this channel ID (leave blank for all)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── CLOCK IN / OUT ───
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.guildId !== GUILD_ID) return;

  const cmd = message.content.trim().toLowerCase();
  const user = message.author;

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
      message.reply(`⏱ You're already clocked in! Clock out first with \`!clockout\`.`);
    } else {
      message.reply(`✅ Clocked in! Your previous total: **${formatMins(data.previousTotal)}**. Good session!`);
    }
  }

  if (cmd === '!clockout' || cmd === 'clock out') {
    const res = await fetch(`${WORKER_URL}/clockout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id }),
    });
    const data = await res.json();
    if (!data.wasClockedIn) {
      message.reply(`❌ You weren't clocked in. Use \`!clockin\` to start.`);
    } else {
      message.reply(
        `🏁 Clocked out! Session: **${formatMins(data.sessionMins)}** · All-time total: **${formatMins(data.totalMins)}**`
      );
    }
  }

  if (cmd === '!mytime') {
    const res = await fetch(`${WORKER_URL}/clock-history?userId=${user.id}`);
    const data = await res.json();
    message.reply(
      `📊 Your all-time training time: **${formatMins(data.totalMins)}**${data.clockedIn ? ' _(currently clocked in)_' : ''}`
    );
  }

  if (cmd === '!leaderboard') {
    const res = await fetch(`${WORKER_URL}/leaderboard`);
    const data = await res.json();
    if (!data.entries || !data.entries.length) {
      message.reply('No data yet — be the first to `!clockin`!');
      return;
    }
    const lines = data.entries
      .slice(0, 10)
      .map((e, i) => `${['🥇','🥈','🥉'][i] || `${i+1}.`} **${e.globalName || e.username}** — ${formatMins(e.totalMins)}`);
    message.reply(`**Training Leaderboard**\n${lines.join('\n')}`);
  }
});

// ─── VOICE STATE TRACKING ───
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const userId   = newState.member?.id || oldState.member?.id;
  const username = newState.member?.user?.username || oldState.member?.user?.username;
  const globalName = newState.member?.user?.globalName || username;
  const avatar   = newState.member?.user?.avatar
    ? `https://cdn.discordapp.com/avatars/${userId}/${newState.member.user.avatar}.png`
    : null;

  if (!userId) return;

  const channelId  = newState.channelId;
  const isStreaming = newState.streaming;
  const isVideo     = newState.selfVideo;
  const channelName = newState.channel?.name || null;

  // Filter to specific channel if configured
  if (VOICE_CHANNEL_ID && channelId && channelId !== VOICE_CHANNEL_ID) return;

  // Joined a voice channel
  if (!oldState.channelId && newState.channelId) {
    await postVoiceState({ userId, username, globalName, avatar, channelId, channelName, streaming: isStreaming, video: isVideo, action: 'join' });
  }
  // Left a voice channel
  else if (oldState.channelId && !newState.channelId) {
    await postVoiceState({ userId, username, globalName, avatar, channelId: null, channelName: null, streaming: false, video: false, action: 'leave' });
  }
  // Changed state (started/stopped streaming, switched channel)
  else if (newState.channelId) {
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

// ─── PERIODIC SYNC: push current voice state snapshot every 30s ───
// This handles cases where the bot restarts mid-session
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

client.once(Events.ClientReady, () => {
  console.log(`✅ Bot ready as ${client.user.tag}`);
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
