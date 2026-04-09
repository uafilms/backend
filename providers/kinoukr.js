// Site: kinoukr.tv → returns Ashdi + Tortuga iframe URLs
// Ashdi parsed via ashdi.js, Tortuga parsed via tortuga.js

const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');
const { getLinksFromAshdiUrl } = require('./ashdi');
const { parseTortugaVod, parseTortugaEmbed } = require('./tortuga');

const BASE = 'https://kinoukr.tv';
const COOKIES = 'onlyforkinoukr=1; lampac-off=1';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:149.0) Gecko/20100101 Firefox/149.0',
    'Cookie': COOKIES,
};

// ── Step 1: get dle_login_hash from main page ─────────────────────────────────

async function getDleHash(axiosConfig) {
    const { data } = await axios.get(`${BASE}/main/`, {
        headers: HEADERS,
        timeout: 15000,
        ...axiosConfig
    });

    const hash = data.match(/dle_login_hash\s*=\s*'([^']+)'/)?.[1] ||
                 data.match(/user_hash\s*=\s*'([^']+)'/)?.[1];
    return hash || null;
}

// ── Step 2: AJAX search ───────────────────────────────────────────────────────

async function search(query, dleHash, axiosConfig) {
    const form = `story=${encodeURIComponent(query)}&dle_hash=${encodeURIComponent(dleHash)}&thisUrl=%2Fmain%2F`;
    const { data } = await axios.post(`${BASE}/engine/lazydev/dle_search/ajax.php`, form, {
        headers: {
            ...HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': BASE,
            'Referer': `${BASE}/main/`
        },
        timeout: 15000,
        ...axiosConfig
    });

    // AJAX returns JSON with content field
    const html = typeof data === 'string' ? data : (data && data.content ? data.content : '');
    if (!html) return [];

    const $ = cheerio.load(html);
    const results = [];

    // Each result is: <a href="..."><span class="searchheading">Title</span>...</a>
    $('a').each((i, el) => {
        const href = $(el).attr('href');
        const title = $(el).find('.searchheading').text().trim();
        if (href && title) {
            results.push({
                title,
                url: href.startsWith('http') ? href : `${BASE}${href}`,
            });
        }
    });

    return results;
}

// ── Step 3: pick best match ───────────────────────────────────────────────────

function normalizeStr(s) {
    return (s || '').trim().toLowerCase();
}

function pickBestResult(results, title, year) {
    const exact = results.find(r => normalizeStr(r.title) === normalizeStr(title));
    if (exact) return exact;

    if (year) {
        const withYear = results.find(r =>
            normalizeStr(r.title).includes(normalizeStr(title)) &&
            new RegExp(`\\b${year}\\b`).test(r.title)
        );
        if (withYear) return withYear;
    }

    const partial = results.find(r => normalizeStr(r.title).includes(normalizeStr(title)));
    if (partial) return partial;

    return results[0];
}

// ── Step 4: get VOD iframes from fplayer tabs-box ─────────────────────────────

async function getVods(pageUrl, axiosConfig) {
    const { data } = await axios.get(pageUrl, {
        headers: HEADERS,
        timeout: 15000,
        ...axiosConfig
    });

    const $ = cheerio.load(data);
    
    // Extract poster from og:image meta tag
    let posterUrl = null;
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) {
        posterUrl = ogImage.startsWith('http') ? ogImage : `${BASE}${ogImage}`;
    }

    const vods = [];

    // Find tabs: first .tabs-sel has tab names as <span> elements
    const tabNames = [];
    const firstTabs = $('.fplayer .tabs-sel, .tabs-sel').first();
    firstTabs.find('span').each((i, el) => {
        const text = $(el).text().trim();
        if (text) tabNames.push(text);
    });

    // Find contents: .tabs-b.video-box with iframes
    const contents = $('.fplayer .tabs-b.video-box, .tabs-b.video-box');

    for (let i = 0; i < contents.length; i++) {
        const iframe = contents.eq(i).find('iframe').attr('src');
        if (!iframe) continue;
        const label = tabNames[i] || `Player ${i + 1}`;
        if (/трейлер/i.test(label)) continue; // skip trailers
        vods.push({ label, url: iframe });
    }

    return { vods, poster: posterUrl };
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
    getLinks: async (imdbId, title, year) => {
        const axiosConfig = proxyManager.getConfig('kinoukr');
        try {
            // Step 1: get hash
            const dleHash = await getDleHash(axiosConfig);

            // Step 2: search
            const query = (imdbId && /^tt\d+$/i.test(imdbId)) ? imdbId : (title || '');
            if (!query) return null;

            let results = await search(query, dleHash, axiosConfig);
            if (!results.length && imdbId && title) {
                results = await search(title, dleHash, axiosConfig);
            }
            if (!results.length) return null;

            // Step 3: pick best match
            const target = pickBestResult(results, title, year);
            if (!target) return null;

            // Step 4: get VODs and poster
            const { vods, poster } = await getVods(target.url, axiosConfig);
            if (!vods.length) return null;

            // Step 5: classify and parse
            const ashdiLinks = [];
            const tortugaIframes = [];

            for (const vod of vods) {
                if (/ashdi/i.test(vod.url)) {
                    try {
                        const parsed = await getLinksFromAshdiUrl(vod.url, title || vod.label);
                        if (parsed && Array.isArray(parsed) && parsed.length) {
                            // Let poster come from VOD source; TMDB backdrop used as fallback in embed
                            ashdiLinks.push(...parsed);
                        }
                    } catch (e) {
                        console.error('[KinoUkr] Ashdi parse error:', e.message);
                    }
                } else if (/tortuga/i.test(vod.url)) {
                    // Collect Tortuga iframe URLs — will be parsed by tortuga.js
                    tortugaIframes.push(vod);
                }
            }

            // Parse Tortuga iframes using tortuga.js
            let tortugaLinks = [];
            if (tortugaIframes.length) {
                for (const vod of tortugaIframes) {
                    if (/tortuga\.tw\/embed\//i.test(vod.url)) {
                        const parsed = await parseTortugaEmbed(vod.url);
                        if (parsed && parsed.length) {
                            // Add poster to each tortuga embed result
                            tortugaLinks.push(...parsed.map(season => ({
                                ...season,
                                folder: (season.folder || []).map(ep => ({
                                    ...ep,
                                    folder: (ep.folder || []).map(dub => ({
                                        ...dub,
                                        poster: dub.poster || null
                                    }))
                                }))
                            })));
                        }
                    } else {
                        const vodData = await parseTortugaVod(vod.url);
                        if (vodData && vodData.file) {
                            tortugaLinks.push({ 
                                title: vod.label || 'Tortuga', 
                                file: vodData.file, 
                                poster: vodData.poster || null // Let TMDB backdrop handle fallback
                            });
                        }
                    }
                }
            }

            const routes = {};
            if (ashdiLinks.length) routes.ashdi = ashdiLinks;
            if (tortugaLinks.length) routes.tortuga = tortugaLinks;

            if (!Object.keys(routes).length) return null;
            return { _routes: routes };
        } catch (e) {
            console.error('[KinoUkr] getLinks error:', e.message);
            return null;
        }
    }
};
