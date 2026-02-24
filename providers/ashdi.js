const axios = require('axios');
const proxyManager = require('../utils/proxyManager');
const tmdb = require('../tmdb');

const MY_PROXY = 'ashdi.aartzz.pp.ua';
const WORMHOLE_API = 'https://wormhole.lampame.v6.rocks';

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const fix = s => typeof s === 'string' ? s.replace(/0yql3tj/g, 'oyql3tj') : s;

// Функція безпечного парсингу JS-об'єктів
function safeParse(str) {
    if (!str) return null;
    try {
        return JSON.parse(str);
    } catch (e) {
        try {
            return new Function('return ' + str)();
        } catch (e2) {
            return null;
        }
    }
}

/**
 * 🆕 НОВИЙ getIframe
 * imdb_id → wormhole → ashdi iframe URL
 */
async function getIframe(imdbId, axiosConfig) {
    try {
        const res = await axios.get(WORMHOLE_API, {
            ...axiosConfig,
            params: { imdb_id: imdbId },
            timeout: 10000
        });

        let src = res?.data?.play;
        if (!src) return null;

        if (src.startsWith('//')) {
            src = 'https:' + src;
        }

        // залишаємо твій проксі
        if (src.includes('ashdi.')) {
            src = src.replace(/ashdi\.[a-z]+/i, MY_PROXY);
        }

        return src;

    } catch (e) {
        console.error(`[Ashdi] Error in getIframe (wormhole): ${e.message}`);
        return null;
    }
}

/**
 * ⛔ НЕ ЧІПАЛИ
 * Парсер JS-плеєра Ashdi → .m3u8
 */
function parsePlayer(html, title) {
    const posterMatch = html.match(/poster\s*:\s*['"]([^'"]+)['"]/);
    const globalPoster = posterMatch ? fix(posterMatch[1]) : null;

    const subMatch = html.match(/subtitle\s*:\s*['"]([^'"]+)['"]/);
    const globalSubtitle = subMatch ? subMatch[1] : null;

    const rawMatch = html.match(/file\s*:\s*(['"])((?:\\\1|.)*?)\1/);
    const raw = rawMatch ? rawMatch[2] : null;
    if (!raw) return null;

    let parsedData = safeParse(raw);

    if (!parsedData && typeof raw === 'string') {
        parsedData = raw;
    }

    // Серіал
    if (Array.isArray(parsedData)) {
        const walk = items => items.map(i => {
            const item = {
                title: i.title ? i.title.trim() : undefined,
            };

            if (i.folder) {
                item.folder = walk(i.folder);
            } else {
                item.file = i.file ? fix(i.file) : undefined;
                item.poster = i.poster ? fix(i.poster) : globalPoster;
                item.subtitle = i.subtitle || globalSubtitle;
            }
            return item;
        });

        return walk(parsedData);
    }

    // Фільм
    if (typeof parsedData === 'string') {
        return [{
            file: fix(parsedData),
            title,
            quality: 'Auto',
            poster: globalPoster,
            subtitle: globalSubtitle
        }];
    }

    return null;
}

module.exports = {

    getLinks: async (imdbId, title) => {
        if (!imdbId) return null;

        const axiosConfig = proxyManager.getConfig('ashdi');

        try {
            const iframe = await getIframe(imdbId, axiosConfig);
            if (!iframe) return null;

            const html = (await axios.get(iframe, {
                ...axiosConfig,
                headers: { 'User-Agent': BASE_HEADERS['User-Agent'] }
            })).data;

            return parsePlayer(html, title);

        } catch (e) {
            console.error(`[Ashdi] Error in getLinks: ${e.message}`);
            return null;
        }
    },

    getStream: async (id, type, season, episode) => {
        try {
            const info = await tmdb.details(type, id);

            let imdbId = info.imdb_id;
            if (!imdbId) {
                const extIds = await tmdb.getExternalIds(id, type === 'tv');
                imdbId = extIds?.imdb_id;
            }
            if (!imdbId) return null;

            const title = info.original_title || info.original_name;
            const links = await module.exports.getLinks(imdbId, title);
            if (!links) return null;

            // Фільм
            if (type === 'movie') {
                const src = Array.isArray(links) ? links[0] : links;
                return src?.file
                    ? { url: src.file, type: 'application/x-mpegURL' }
                    : null;
            }

            // Серіал
            let found = null;
            const walk = (items, sCtx) => {
                for (const it of items) {
                    let s = sCtx, e = null;
                    const t = it.title || '';

                    const sm = t.match(/(\d+)\s*(?:season|сезон)|(?:season|сезон)\s*(\d+)/i);
                    if (sm) s = parseInt(sm[1] || sm[2]);

                    const em = t.match(/(\d+)\s*(?:episode|серія)|(?:ep|e)\s*(\d+)/i);
                    if (em) e = parseInt(em[1] || em[2]);

                    if (it.folder) walk(it.folder, s);
                    else if (it.file && s == season && e == episode) {
                        found = it.file;
                        return;
                    }
                }
            };

            if (Array.isArray(links)) walk(links, null);

            return found
                ? { url: found, type: 'application/x-mpegURL' }
                : null;

        } catch (e) {
            console.error('[Ashdi] getStream error:', e.message);
            return null;
        }
    }
};