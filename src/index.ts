import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  TextChannel,
  Message,
  AttachmentBuilder
} from 'discord.js';

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
    GatewayIntentBits.MessageContent // privileged — enable in Dev Portal if you need message text
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// in-memory map originalMsgId -> forwardedMsgId
const forwardMap = new Map<string, string>();

client.once('ready', () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

function isSourceChannel(id?: string) {
  return !!id && SOURCE_CHANNELS.includes(id);
}

function isImageAttachment(att: { contentType?: string | null; name?: string | null; url?: string }) {
  const ct = att.contentType ?? '';
  if (ct) return ct.startsWith('image');
  const name = att.name ?? '';
  const url = att.url ?? '';
  return /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name) || /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(url);
}

function safeAuthorTag(m: Message) {
  // message.author may be undefined on partials; try member.user fallback; finally unknown placeholder
  const author = (m.author ?? (m.member?.user as any)) as { tag?: string; username?: string } | undefined;
  if (author?.tag) return author.tag;
  if (author?.username) return `${author.username}#0000`;
  return 'Unknown#0000';
}

function safeChannelRef(m: Message) {
  return m.channelId ?? 'unknown-channel';
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return; // avoid loops
    if (!isSourceChannel(message.channelId)) return;

    // image attachments (filter by contentType or filename/url)
    const imageAttachments = message.attachments.filter(att => isImageAttachment(att));

    // embed / thumbnail images (type-safe)
    const embedImageUrls: string[] = [];
    for (const e of message.embeds) {
      if (e.image?.url) {
        embedImageUrls.push(e.image.url);
        continue;
      }
      if (e.thumbnail?.url) {
        embedImageUrls.push(e.thumbnail.url);
        continue;
      }
      // some embeds place an image at embed.url — include if present
      const maybeUrl = (e as any).url;
      if (typeof maybeUrl === 'string' && maybeUrl) embedImageUrls.push(maybeUrl);
    }

    // nothing image-like? skip
    if (imageAttachments.size === 0 && embedImageUrls.length === 0) return;

    const target = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!target || !target.isTextBased()) return;
    const targetChannel = target as TextChannel;

    const header = `**${safeAuthorTag(message)}** from <#${safeChannelRef(message)}>`;

    const files: AttachmentBuilder[] = [];
    for (const att of imageAttachments.values()) {
      // reattach by URL (works in most cases)
      files.push(new AttachmentBuilder(att.url).setName(att.name ?? 'image'));
    }
    for (const url of embedImageUrls) {
      const guessedName = url.split('?')[0].split('/').pop() ?? 'image';
      files.push(new AttachmentBuilder(url).setName(guessedName));
    }

    const sent = await targetChannel.send({
      content: header,
      files,
      allowedMentions: { parse: [] }
    });

    forwardMap.set(message.id, sent.id);
  } catch (err) {
    console.error('messageCreate error', err);
  }
});

client.on('messageUpdate', async (_, newMessage) => {
  try {
    if (newMessage.partial) await newMessage.fetch().catch(() => {});
    // newMessage might now be a Message after fetch
    const msg = newMessage as Message;
    if (!isSourceChannel(msg.channelId)) return;

    const imageAttachments = msg.attachments.filter(att => isImageAttachment(att));
    const embedImageUrls: string[] = [];
    for (const e of msg.embeds) {
      if (e.image?.url) {
        embedImageUrls.push(e.image.url);
        continue;
      }
      if (e.thumbnail?.url) {
        embedImageUrls.push(e.thumbnail.url);
        continue;
      }
      const maybeUrl = (e as any).url;
      if (typeof maybeUrl === 'string' && maybeUrl) embedImageUrls.push(maybeUrl);
    }

    const forwardedId = forwardMap.get(msg.id);

    // if message no longer has images, delete forwarded copy (if exists)
    if (imageAttachments.size === 0 && embedImageUrls.length === 0) {
      if (forwardedId) {
        const targetCh = (await client.channels.fetch(TARGET_CHANNEL_ID)) as TextChannel;
        const forwarded = await targetCh.messages.fetch(forwardedId).catch(() => null);
        if (forwarded) await forwarded.delete().catch(() => {});
        forwardMap.delete(msg.id);
      }
      return;
    }

    // if forwarded exists, update header only (attachments can't be edited easily)
    if (forwardedId) {
      const targetCh = (await client.channels.fetch(TARGET_CHANNEL_ID)) as TextChannel;
      const forwarded = await targetCh.messages.fetch(forwardedId).catch(() => null);
      if (forwarded) {
        const authorTag = safeAuthorTag(msg);
        const channelRef = safeChannelRef(msg);
        const header = `**${authorTag}** from <#${channelRef}> (edited)`;
        await forwarded.edit({ content: header }).catch(() => {});
      }
      return;
    }

    // else: newMessage has images and wasn't forwarded before -> forward it
    const target = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!target || !target.isTextBased()) return;
    const targetChannel = target as TextChannel;

    const authorTag = safeAuthorTag(msg);
    const channelRef = safeChannelRef(msg);
    const header = `**${authorTag}** from <#${channelRef}> (edited)`;

    const files: AttachmentBuilder[] = [];
    for (const att of imageAttachments.values()) {
      files.push(new AttachmentBuilder(att.url).setName(att.name ?? 'image'));
    }
    for (const url of embedImageUrls) {
      const guessedName = url.split('?')[0].split('/').pop() ?? 'image';
      files.push(new AttachmentBuilder(url).setName(guessedName));
    }

    const sent = await targetChannel.send({
      content: header,
      files,
      allowedMentions: { parse: [] }
    });
    forwardMap.set(msg.id, sent.id);
  } catch (err) {
    console.error('messageUpdate error', err);
  }
});

client.on('messageDelete', async (message) => {
  try {
    const forwardedId = forwardMap.get(message.id);
    if (!forwardedId) return;
    const targetCh = (await client.channels.fetch(TARGET_CHANNEL_ID)) as TextChannel;
    const forwarded = await targetCh.messages.fetch(forwardedId).catch(() => null);
    if (forwarded) await forwarded.delete().catch(() => {});
    forwardMap.delete(message.id);
  } catch (err) {
    console.error('messageDelete handler error', err);
  }
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

client.login(token);

// --- Tiny HTTP server so Render sees an open port (for Web Service) ---
import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => {
  console.log(`[Health] Listening on port ${PORT}`);
});
