const axios = require('axios');
const proxyManager = require('../utils/proxyManager');
const tmdb = require('../tmdb');

const MY_PROXY = 'ashdi.aartzz.pp.ua';
const WORMHOLE_API = 'https://wormhole.lampame.v6.rocks';

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const fix = s => typeof s === 'string'
    ? s.replace(/0yql3tj/g, 'oyql3tj')
    : s;

// ===== safeParse — НЕ МІНЯЄМО =====
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
 * ✅ getIframe
 * imdb_id → wormhole → ashdi iframe
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

        if (src.includes('ashdi.')) {
            src = src.replace(/ashdi\.[a-z]+/i, MY_PROXY);
        }

        // 🔑 multivoice для фільмів
        if (/\/vod\/\d+/i.test(src) && !src.includes('multivoice')) {
            src += (src.includes('?') ? '&' : '?') + 'multivoice';
        }

        return src;

    } catch (e) {
        console.error('[Ashdi] getIframe error:', e.message);
        return null;
    }
}

/**
 * ❗ parsePlayer
 * ПОВЕРТАЄ СТАРИЙ ФОРМАТ + name
 * щоб normalizeResponse() коректно діставав dub
 */
function parsePlayer(html, fallbackTitle) {
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

    // 🎬 multivoice (ARRAY)
    if (Array.isArray(parsedData)) {
        return parsedData.map(i => {
            const voiceTitle = (i.title || fallbackTitle || '').trim();
            return {
                title: voiceTitle,          // лишаємо для сумісності
                name: voiceTitle,           // 🔑 САМЕ ЦЕ ЧИТАЄ normalizeResponse
                file: fix(i.file),
                poster: fix(i.poster) || globalPoster,
                subtitle: i.subtitle || globalSubtitle
            };
        });
    }

    // 🎬 single stream
    if (typeof parsedData === 'string') {
        const t = (fallbackTitle || '').trim();
        return [{
            title: t,
            name: t,                       // 🔑
            file: fix(parsedData),
            poster: globalPoster,
            subtitle: globalSubtitle
        }];
    }

    return null;
}

module.exports = {

    /**
     * 🔑 index.js викликає САМЕ getLinks
     * формат НЕ міняємо
     */
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
            console.error('[Ashdi] getLinks error:', e.message);
            return null;
        }
    }
};