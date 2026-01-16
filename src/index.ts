import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events
} from 'discord.js';
import http from 'node:http';
import { handleMessageCreate } from './events/messageCreate.js';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN missing from .env');

const SOURCE_CHANNELS = (process.env.SOURCE_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL;
if (!TARGET_CHANNEL_ID) throw new Error('TARGET_CHANNEL missing from .env');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent // privileged — enable in Dev Portal
  ],
  partials: [Partials.Message, Partials.Channel],
  rest: {
    timeout: 60000 // Increase timeout to 60 seconds for large media uploads
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  // Warm up the cache for the target channel
  await client.channels.fetch(TARGET_CHANNEL_ID).catch(() => { });
  console.log(`Monitoring ${SOURCE_CHANNELS.length} source channels.`);
});

client.on('messageCreate', async (message) => {
  await handleMessageCreate(message, SOURCE_CHANNELS, TARGET_CHANNEL_ID);
});

// Stateless: We no longer track updates or deletes as requested.

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

client.login(token);

// --- Health Check HTTP Server for Render ---
const PORT = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => {
  console.log(`[Health] Listening on port ${PORT}`);
}
);
