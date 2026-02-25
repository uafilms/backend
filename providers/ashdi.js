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

    /* =====================================================
       🎬 EXTRACT file:'...'
    ===================================================== */

    const rawMatch = html.match(/file\s*:\s*(['"])((?:\\\1|.)*?)\1/);
    if (!rawMatch) return null;

    let raw = rawMatch[2];
    let parsed = safeParse(raw);

    /* =====================================================
       🎬 SIMPLE FILM / MULTIVOICE
    ===================================================== */

    if (typeof parsed === 'string') {
        const t = (fallbackTitle || '').trim();
        return [{
            title: t,
            name: t,
            file: fix(parsed),
            poster: globalPoster,
            subtitle: globalSubtitle
        }];
    }

    if (Array.isArray(parsed) && parsed[0]?.file) {
        return parsed.map(i => ({
            title: (i.title || fallbackTitle || '').trim(),
            name: (i.title || fallbackTitle || '').trim(),
            file: fix(i.file),
            poster: fix(i.poster) || globalPoster,
            subtitle: i.subtitle || globalSubtitle
        }));
    }

    /* =====================================================
       📺 SERIAL PLAYERJS TREE (🔥 MAIN FIX)
    ===================================================== */

    const results = [];

    function walk(node, ctx = {}) {
        if (!node) return;

        // верхній рівень = студія / дубляж
        if (node.title && !ctx.dub) {
            ctx = { ...ctx, dub: node.title.trim() };
        }

        // сезон
        if (/сезон/i.test(node.title || '')) {
            const m = node.title.match(/(\d+)/);
            if (m) ctx = { ...ctx, season: parseInt(m[1]) };
        }

        // серія
        if (/серія/i.test(node.title || '')) {
            const m = node.title.match(/(\d+)/);
            if (m) ctx = { ...ctx, episode: parseInt(m[1]) };
        }

        // LEAF
        if (node.file && typeof node.file === 'string') {
            results.push({
                title: node.title?.trim() || fallbackTitle,
                name: ctx.dub || fallbackTitle,
                file: fix(node.file),
                poster: fix(node.poster) || globalPoster,
                subtitle: node.subtitle || globalSubtitle,
                season: ctx.season,
                episode: ctx.episode
            });
        }

        // RECURSE
        if (Array.isArray(node.folder)) {
            node.folder.forEach(child =>
                walk(child, { ...ctx })
            );
        }
    }

    parsed.forEach(root => walk(root));

    return results.length ? results : null;
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