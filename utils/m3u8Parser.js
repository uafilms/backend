const { URL } = require('url');

/**
 * Парсить m3u8:
 * - Вкладені плейлисти (.m3u8) -> загортає в наш локальний проксі.
 * - Сегменти (.ts, .mp4) -> перетворює в прямі абсолютні посилання на оригінал.
 */
function parseMasterPlaylist(content, baseUrl, proxyHost) {
    const lines = content.split('\n');
    const newLines = [];

    lines.forEach(line => {
        const trimmed = line.trim();

        if (!trimmed) return;

        // Копіюємо теги без змін
        if (trimmed.startsWith('#')) {
            newLines.push(trimmed);
        } else {
            // Це URL (сегмент або плейлист)
            try {
                // 1. Робимо URL абсолютним, базуючись на оригінальному джерелі
                const absoluteUrl = new URL(trimmed, baseUrl).href;
                
                // 2. Логіка підміни:
                // Якщо це вкладений плейлист (.m3u8) - проксіюємо його, щоб уникнути CORS при виборі якості.
                if (absoluteUrl.includes('.m3u8')) {
                    const encodedUrl = encodeURIComponent(absoluteUrl);
                    // Формуємо посилання на наш маршрут /proxy/m3u8
                    newLines.push(`${proxyHost}/proxy/m3u8?url=${encodedUrl}`);
                } else {
                    // Якщо це сегмент (.ts) - залишаємо пряме посилання на сервер-джерело.
                    // Браузер зможе його завантажити, якщо сервер дозволяє (зазвичай сегменти не мають суворого CORS).
                    newLines.push(absoluteUrl);
                }
            } catch (e) {
                // Якщо не вдалось розпарсити URL, залишаємо рядок як є
                console.error('Error parsing line in m3u8:', trimmed);
                newLines.push(trimmed);
            }
        }
    });

    return newLines.join('\n');
}

module.exports = { parseMasterPlaylist };