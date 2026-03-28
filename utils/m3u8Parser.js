const { URL } = require('url');

const CORS_PROXY = 'https://cors.bwa.workers.dev/';

/**
 * Парсить m3u8:
 * - URL після #EXT-X-STREAM-INF (якісні плейлисти) → завжди проксуємо через /proxy/m3u8
 * - URL після #EXTINF (сегменти .ts/.mp4) → прямі абсолютні посилання
 * - Якщо прямі сегменти мають CORS проблеми → fallback через cors.bwa.workers.dev
 */
function parseMasterPlaylist(content, baseUrl, proxyHost, options = {}) {
    const { corsProxySegments = false } = options;
    const lines = content.split('\n');
    const newLines = [];

    let nextIsStreamUrl = false; // після #EXT-X-STREAM-INF
    let nextIsSegmentUrl = false; // після #EXTINF або #EXT-X-BYTERANGE

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('#')) {
            newLines.push(trimmed);
            if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
                nextIsStreamUrl = true;
                nextIsSegmentUrl = false;
            } else if (trimmed.startsWith('#EXTINF') || trimmed.startsWith('#EXT-X-BYTERANGE')) {
                nextIsSegmentUrl = true;
                nextIsStreamUrl = false;
            } else {
                // Будь-який інший тег не змінює стан
            }
            continue;
        }

        // Це URL рядок
        try {
            const absoluteUrl = new URL(trimmed, baseUrl).href;

            if (nextIsStreamUrl) {
                // Якісний плейлист — завжди проксуємо
                newLines.push(`${proxyHost}/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}`);
                nextIsStreamUrl = false;
            } else if (nextIsSegmentUrl) {
                // Сегмент — прямий URL або через CORS proxy якщо потрібно
                newLines.push(corsProxySegments ? `${CORS_PROXY}${absoluteUrl}` : absoluteUrl);
                nextIsSegmentUrl = false;
            } else {
                // Невідомий контекст: проксуємо якщо схоже на плейлист, інакше прямий URL
                const looksLikePlaylist =
                    absoluteUrl.includes('.m3u8') ||
                    /\/(index|master|playlist|stream|hls)(\/|\?|$)/i.test(absoluteUrl);

                if (looksLikePlaylist) {
                    newLines.push(`${proxyHost}/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}`);
                } else {
                    newLines.push(corsProxySegments ? `${CORS_PROXY}${absoluteUrl}` : absoluteUrl);
                }
            }
        } catch (e) {
            console.error('[m3u8Parser] Error parsing URL:', trimmed);
            newLines.push(trimmed);
        }
    }

    return newLines.join('\n');
}

module.exports = { parseMasterPlaylist };
