import 'dotenv/config';
import http from 'node:http';
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

/**
 * Config (via env)
 */
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024); // default 8 MB
const UPLOAD_DELAY_MS = Number(process.env.UPLOAD_DELAY_MS ?? 800); // ms delay between downloads/uploads

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
  return /\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:\?.*)?$/i.test(name) || /\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:\?.*)?$/i.test(url);
}

function safeAuthorTag(m: Message) {
  const author = (m.author ?? (m.member?.user as any)) as { tag?: string; username?: string } | undefined;
  if (author?.tag) return author.tag;
  if (author?.username) return `${author.username}#0000`;
  return 'Unknown#0000';
}

function safeChannelRef(m: Message) {
  return m.channelId ?? 'unknown-channel';
}

/* -----------------------
   Helpers: download buffers and build AttachmentBuilder[]
   ----------------------- */

async function downloadToBuffer(url: string): Promise<{ buffer: Buffer; name: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`download failed ${url} -> ${res.status}`);
      return null;
    }
    const array = await res.arrayBuffer();
    const buf = Buffer.from(array);
    // infer a filename from URL path or content-type
    let filename = 'image';
    try {
      const pathname = new URL(url).pathname;
      const basename = pathname.split('/').pop();
      if (basename && basename.length > 0) filename = basename;
    } catch { /* ignore */ }
    if (!/\.[a-z0-9]{2,6}$/i.test(filename)) {
      const ct = res.headers.get('content-type') ?? '';
      const m = /image\/([a-z0-9.+-]+)/i.exec(ct);
      const ext = m ? m[1].replace('+', '') : 'jpg';
      filename = `${filename}.${ext}`;
    }
    return { buffer: buf, name: filename };
  } catch (err) {
    console.warn('downloadToBuffer error', err);
    return null;
  }
}

async function makeFilesFromUrls(urls: string[], fallbackNames: (string | undefined)[] = []) {
  const files: AttachmentBuilder[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const fallback = fallbackNames[i];
    const d = await downloadToBuffer(url);
    if (!d) {
      console.warn('skipping url (download failed):', url);
      continue;
    }
    if (d.buffer.byteLength > MAX_UPLOAD_BYTES) {
      console.warn(`skipping ${d.name} (${(d.buffer.byteLength / 1024 / 1024).toFixed(2)} MB) > MAX_UPLOAD_BYTES`);
      continue;
    }
    const safeName = (fallback ?? d.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    files.push(new AttachmentBuilder(d.buffer, { name: safeName }));
    await new Promise(r => setTimeout(r, UPLOAD_DELAY_MS));
  }
  return files;
}

/* -----------------------
   New helper: fetch attachments if an embed links to a Discord message
   ----------------------- */

async function fetchAttachmentsFromEmbedMessageLink(embed: any): Promise<{ url: string; name?: string }[]> {
  try {
    if (!embed?.url || typeof embed.url !== 'string') return [];
    const m = embed.url.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i);
    if (!m) return [];
    const [, guildId, channelId, messageId] = m;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return [];
    const msg = await (ch as TextChannel).messages.fetch(messageId).catch(() => null);
    if (!msg) return [];
    const results: { url: string; name?: string }[] = [];

    for (const a of msg.attachments.values()) {
      if (isImageAttachment(a)) results.push({ url: a.url, name: a.name ?? undefined });
    }
    for (const e of msg.embeds) {
      if (e.image?.url) results.push({ url: e.image.url });
      else if (e.thumbnail?.url) results.push({ url: e.thumbnail.url });
      else {
        const maybe = (e as any).url;
        if (typeof maybe === 'string' && maybe) results.push({ url: maybe });
      }
    }
    return results;
  } catch (err) {
    console.warn('fetchAttachmentsFromEmbedMessageLink error', err);
    return [];
  }
}

/* -----------------------
   messageCreate — download & re-upload (with embed message-link handling)
   ----------------------- */

client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return; // avoid loops
    if (!isSourceChannel(message.channelId)) return;

    const imageAttachments = message.attachments.filter(att => isImageAttachment(att));

    // collect embed-derived URLs and names; handle message-link embeds specially
    const embedImageUrls: string[] = [];
    const embedFallbackNames: (string | undefined)[] = [];
    for (const e of message.embeds) {
      if (e.image?.url) { embedImageUrls.push(e.image.url); embedFallbackNames.push(undefined); continue; }
      if (e.thumbnail?.url) { embedImageUrls.push(e.thumbnail.url); embedFallbackNames.push(undefined); continue; }
      const maybeUrl = (e as any).url;
      if (typeof maybeUrl === 'string' && maybeUrl) {
        // direct image link?
        if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:\?.*)?$/i.test(maybeUrl)) {
          embedImageUrls.push(maybeUrl);
          embedFallbackNames.push(undefined);
          continue;
        }
        // try message-link fetching
        const fromLink = await fetchAttachmentsFromEmbedMessageLink(e);
        if (fromLink.length > 0) {
          for (const it of fromLink) {
            embedImageUrls.push(it.url);
            embedFallbackNames.push(it.name ?? undefined);
          }
          continue;
        }
        // fallback: include the URL as-is
        embedImageUrls.push(maybeUrl);
        embedFallbackNames.push(undefined);
      }
    }

    if (imageAttachments.size === 0 && embedImageUrls.length === 0) return;

    const target = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!target || !target.isTextBased()) return;
    const targetChannel = target as TextChannel;

    const urls: string[] = [];
    const names: (string | undefined)[] = [];
    for (const att of imageAttachments.values()) {
      urls.push(att.url);
      names.push(att.name ?? undefined);
    }
    for (let i = 0; i < embedImageUrls.length; i++) {
      urls.push(embedImageUrls[i]);
      names.push(embedFallbackNames[i]);
    }

    // debug: see what we found (remove after testing)
    console.log('[DEBUG] collected image urls (messageCreate):', urls);

    const files = await makeFilesFromUrls(urls, names);

    const header = `**${safeAuthorTag(message)}** from <#${safeChannelRef(message)}>`;
    if (files.length === 0) {
      const text = urls.join('\n');
      const sent = await targetChannel.send({ content: `${header}\n${text}`, allowedMentions: { parse: [] } });
      forwardMap.set(message.id, sent.id);
      return;
    }

    const sent = await targetChannel.send({ content: header, files, allowedMentions: { parse: [] } });
    forwardMap.set(message.id, sent.id);
  } catch (err) {
    console.error('messageCreate error (reupload)', err);
  }
});

/* -----------------------
   messageUpdate — same logic as create (fetch original if embed is a message link)
   ----------------------- */

client.on('messageUpdate', async (_, newMessage) => {
  try {
    if (newMessage.partial) await newMessage.fetch().catch(() => {});
    const msg = newMessage as Message;
    if (!isSourceChannel(msg.channelId)) return;

    const imageAttachments = msg.attachments.filter(att => isImageAttachment(att));

    const embedImageUrls: string[] = [];
    const embedFallbackNames: (string | undefined)[] = [];
    for (const e of msg.embeds) {
      if (e.image?.url) { embedImageUrls.push(e.image.url); embedFallbackNames.push(undefined); continue; }
      if (e.thumbnail?.url) { embedImageUrls.push(e.thumbnail.url); embedFallbackNames.push(undefined); continue; }
      const maybeUrl = (e as any).url;
      if (typeof maybeUrl === 'string' && maybeUrl) {
        if (/\.(jpe?g|png|gif|webp|bmp|svg|avif)(?:\?.*)?$/i.test(maybeUrl)) {
          embedImageUrls.push(maybeUrl);
          embedFallbackNames.push(undefined);
          continue;
        }
        const fromLink = await fetchAttachmentsFromEmbedMessageLink(e);
        if (fromLink.length > 0) {
          for (const it of fromLink) {
            embedImageUrls.push(it.url);
            embedFallbackNames.push(it.name ?? undefined);
          }
          continue;
        }
        embedImageUrls.push(maybeUrl);
        embedFallbackNames.push(undefined);
      }
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

    // Prepare urls/names
    const urls: string[] = [];
    const names: (string | undefined)[] = [];
    for (const att of imageAttachments.values()) {
      urls.push(att.url);
      names.push(att.name ?? undefined);
    }
    for (let i = 0; i < embedImageUrls.length; i++) {
      urls.push(embedImageUrls[i]);
      names.push(embedFallbackNames[i]);
    }

    // debug:
    console.log('[DEBUG] collected image urls (messageUpdate):', urls);

    const files = await makeFilesFromUrls(urls, names);
    const targetCh = (await client.channels.fetch(TARGET_CHANNEL_ID)) as TextChannel;

    if (forwardedId) {
      // delete old forwarded message (if exists) and resend new files/header
      const forwarded = await targetCh.messages.fetch(forwardedId).catch(() => null);
      if (forwarded) await forwarded.delete().catch(() => {});
      const header = `**${safeAuthorTag(msg)}** from <#${safeChannelRef(msg)}> (edited)`;
      if (files.length === 0) {
        const sent = await targetCh.send({ content: `${header}\n${urls.join('\n')}`, allowedMentions: { parse: [] } });
        forwardMap.set(msg.id, sent.id);
      } else {
        const sent = await targetCh.send({ content: header, files, allowedMentions: { parse: [] } });
        forwardMap.set(msg.id, sent.id);
      }
      return;
    }

    // If not forwarded before => forward now
    const header = `**${safeAuthorTag(msg)}** from <#${safeChannelRef(msg)}> (edited)`;
    if (files.length === 0) {
      const sent = await targetCh.send({ content: `${header}\n${urls.join('\n')}`, allowedMentions: { parse: [] } });
      forwardMap.set(msg.id, sent.id);
    } else {
      const sent = await targetCh.send({ content: header, files, allowedMentions: { parse: [] } });
      forwardMap.set(msg.id, sent.id);
    }
  } catch (err) {
    console.error('messageUpdate error (reupload)', err);
  }
});

/* -----------------------
   messageDelete — delete forwarded copy if mapped
   ----------------------- */

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

/* -----------------------
   Tiny health-check server for Render Web Service
   ----------------------- */
const PORT = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => {
  console.log(`[Health] Listening on port ${PORT}`);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

client.login(token);
