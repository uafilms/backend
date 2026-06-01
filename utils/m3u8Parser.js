const { URL } = require('url');

const CORS_PROXY = 'https://cors.bwa.workers.dev/';

/**
 * Якщо URL вже загорнутий у CORS_PROXY — повертає inner URL,
 * інакше повертає оригінал.
 */
function stripCorsProxy(url) {
    const prefix = CORS_PROXY.replace(/\/+$/, '/');
    while (url.startsWith(prefix)) {
        url = url.slice(prefix.length);
    }
    return url;
}

function parseMasterPlaylist(content, baseUrl, proxyHost, options = {}) {
    const { corsProxySegments = false } = options;
    const lines = content.split('\n');
    const newLines = [];

    // Нормалізуємо baseUrl — вирізаємо CORS_PROXY, щоб не резолвити
    // відносні сегменти в уже проксований URL (призводить до подвійного проксі)
    const cleanBaseUrl = stripCorsProxy(baseUrl);

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
            const absoluteUrl = new URL(trimmed, cleanBaseUrl).href;

            if (nextIsStreamUrl) {
                // Якісний плейлист — завжди проксуємо
                newLines.push(`${proxyHost}/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}`);
                nextIsStreamUrl = false;
            } else if (nextIsSegmentUrl) {
                // Сегмент — прямий URL або через CORS proxy якщо потрібно
                // АЛЕ якщо URL вже містить CORS_PROXY (напр. через nested .m3u8),
                // не загортаємо вдруге
                if (corsProxySegments && !absoluteUrl.startsWith(CORS_PROXY)) {
                    newLines.push(`${CORS_PROXY}${absoluteUrl}`);
                } else {
                    newLines.push(absoluteUrl);
                }
                nextIsSegmentUrl = false;
            } else {
                // Невідомий контекст: проксуємо якщо схоже на плейлист, інакше прямий URL
                const looksLikePlaylist =
                    absoluteUrl.includes('.m3u8') ||
                    /\/(index|master|playlist|stream|hls)(\/|\?|$)/i.test(absoluteUrl);

                if (looksLikePlaylist) {
                    newLines.push(`${proxyHost}/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}`);
                } else {
                    // Не загортаємо вдруге
                    if (corsProxySegments && !absoluteUrl.startsWith(CORS_PROXY)) {
                        newLines.push(`${CORS_PROXY}${absoluteUrl}`);
                    } else {
                        newLines.push(absoluteUrl);
                    }
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
