import { Message, AttachmentBuilder } from 'discord.js';

/**
 * Checks if an attachment is an image, video, or audio file.
 */
export function isMediaAttachment(att: { contentType?: string | null; name?: string | null; url?: string }) {
    const ct = att.contentType ?? '';
    if (ct) {
        return ct.startsWith('image') || ct.startsWith('video') || ct.startsWith('audio');
    }

    const name = att.name ?? '';
    const url = att.url ?? '';
    const mediaRegex = /\.(jpe?g|png|gif|webp|bmp|svg|mp4|mov|webm|mp3|wav|ogg|flac|m4a)$/i;

    return mediaRegex.test(name) || mediaRegex.test(url);
}

/**
 * Extracts and prepares all media files (attachments and valid embed URLs) from a message.
 */
export function getMediaFiles(message: Message): AttachmentBuilder[] {
    const files: AttachmentBuilder[] = [];

    // 1. Process attachments
    const mediaAttachments = message.attachments.filter(att => isMediaAttachment(att));
    for (const att of mediaAttachments.values()) {
        files.push(new AttachmentBuilder(att.url).setName(att.name ?? 'file'));
    }

    // 2. Process embeds (Discord often embeds images/videos)
    for (const e of message.embeds) {
        if (e.image?.url) {
            files.push(new AttachmentBuilder(e.image.url).setName(guessName(e.image.url)));
            continue;
        }
        if (e.thumbnail?.url) {
            files.push(new AttachmentBuilder(e.thumbnail.url).setName(guessName(e.thumbnail.url)));
            continue;
        }
        if (e.video?.url) {
            files.push(new AttachmentBuilder(e.video.url).setName(guessName(e.video.url)));
            continue;
        }

        // Generic URL fallback for some embeds
        const maybeUrl = (e as any).url;
        if (typeof maybeUrl === 'string' && maybeUrl) {
            files.push(new AttachmentBuilder(maybeUrl).setName(guessName(maybeUrl)));
        }
    }

    return files;
}

function guessName(url: string): string {
    try {
        return url.split('?')[0].split('/').pop() ?? 'file';
    } catch {
        return 'file';
    }
}

/**
 * Safely generates an author tag even for partials or weird edge cases.
 */
export function safeAuthorTag(m: Message): string {
    const author = m.author ?? (m.member?.user as any);
    if (author?.tag) return author.tag;
    if (author?.username) return `${author.username}#0000`;
    return 'Unknown#0000';
}

/**
 * Safely returns the channel reference.
 */
export function safeChannelRef(m: Message): string {
    return m.channelId ?? 'unknown-channel';
}
