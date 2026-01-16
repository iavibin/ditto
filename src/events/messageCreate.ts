import { Message, TextChannel } from 'discord.js';
import { getMediaFiles, safeAuthorTag, safeChannelRef } from '../utils/media.js';

export async function handleMessageCreate(message: Message, sourceChannels: string[], targetChannelId: string) {
    try {
        if (message.author.bot) return; // avoid loops
        if (!sourceChannels.includes(message.channelId)) return;

        const files = getMediaFiles(message);

        // If no media files found, skip
        if (files.length === 0) return;

        // Use cache for maximum speed, fallback to fetch if not cached
        let targetChannel = message.client.channels.cache.get(targetChannelId) as TextChannel;
        if (!targetChannel) {
            const fetched = await message.client.channels.fetch(targetChannelId);
            if (!fetched || !fetched.isTextBased()) return;
            targetChannel = fetched as TextChannel;
        }

        const header = `**${safeAuthorTag(message)}** from <#${safeChannelRef(message)}>`;

        // Forward with the header and media files
        await targetChannel.send({
            content: header,
            files,
            allowedMentions: { parse: [] }
        });

    } catch (err) {
        console.error('Error in messageCreate handler:', err);
    }

}
