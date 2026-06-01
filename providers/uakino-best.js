const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');
const { parsePlayer, normalizeUrl, NAV_HEADERS } = require('./ashdi');
const { parseTortugaVod } = require('./tortuga');

const BASE = 'https://uakino.best';
const SEARCH_URL = `${BASE}/engine/lazydev/dle_search/ajax.php`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0';

const COMMON_HEADERS = {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
};

const SEARCH_HEADERS = {
    ...COMMON_HEADERS,
    'Accept': '*/*',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': BASE,
    'Referer': `${BASE}/ua/`,
};

const PLAYLIST_HEADERS = {
    ...COMMON_HEADERS,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `${BASE}/`,
};

// ── Search ───────────────────────────────────────────────────────────────────

async function search(query, signal) {
    const { data } = await axios.post(SEARCH_URL,
        `story=${encodeURIComponent(query)}&thisUrl=%2Fua%2F`,
        { headers: SEARCH_HEADERS, timeout: 15000, ...(signal ? { signal } : {}) }
    );

    const json = typeof data === 'string' ? JSON.parse(data) : data;
    if (!json.content) return [];

    const $ = cheerio.load(json.content);
    const results = [];

    $('a.search-result-link').each((i, el) => {
        const href = $(el).attr('href');
        const title = $(el).find('.searchheading').text().trim().replace(/\s+/g, ' ');
        const origTitle = $(el).find('.search-orig-title').text().trim();
        const year = $(el).find('.search-extend-info span').first().text().trim();
        if (href && title) results.push({ url: href, title, origTitle, year });
    });

    return results;
}

// ── Extract news_id from URL ────────────────────────────────────────────────

function getNewsId(url) {
    const m = url.match(/(\d+)-[^/]*\.html/);
    return m ? m[1] : null;
}

// ── Detect season from title text ────────────────────────────────────────────

function detectSeason(text) {
    const m = text.match(/(\d+)\s*(?:сезон|season)/i);
    return m ? parseInt(m[1]) : null;
}

// ── Fetch playlist for a TV season ──────────────────────────────────────────

async function fetchPlaylist(newsId, pageUrl, signal) {
    const ref = pageUrl.startsWith('http') ? pageUrl : `${BASE}${pageUrl}`;
    const { data } = await axios.get(
        `${BASE}/engine/ajax/playlists.php?news_id=${newsId}&xfield=playlist`,
        { headers: { ...PLAYLIST_HEADERS, 'Referer': ref }, timeout: 15000, ...(signal ? { signal } : {}) }
    );

    const json = typeof data === 'string' ? JSON.parse(data) : data;
    if (!json.success || !json.response) return null;

    const $ = cheerio.load(json.response);

    // Extract voices from tabs
    const voices = [];
    $('.playlists-lists li[data-id]').each((i, el) => {
        const voiceName = $(el).text().trim().replace(/\s*\([\d\-,]+\).*$/, '');
        const dataId = $(el).attr('data-id');
        if (dataId) voices.push({ name: voiceName, dataId });
    });

    // If no voice tabs, create a default one
    if (!voices.length) voices.push({ name: 'Original', dataId: '0_0' });

    // Extract episodes per voice
    const episodesByVoice = {};
    $('.playlists-videos li[data-file]').each((i, el) => {
        const file = $(el).attr('data-file');
        const epTitle = $(el).text().trim();
        const voice = $(el).attr('data-voice') || 'Original';
        const epNum = parseInt(epTitle.match(/\d+/)?.[0]) || i + 1;

        if (!episodesByVoice[voice]) episodesByVoice[voice] = [];
        episodesByVoice[voice].push({ file: file.startsWith('//') ? 'https:' + file : file, episode: epNum });
    });

    return { voices: voices.map(v => v.name), episodes: episodesByVoice };
}

// ── Scrape movie page for player iframe ──────────────────────────────────

async function scrapeMovie(pageUrl, signal) {
    const url = pageUrl.startsWith('http') ? pageUrl : `${BASE}${pageUrl}`;
    const { data } = await axios.get(url, {
        headers: { ...COMMON_HEADERS, 'Referer': `${BASE}/`, 'Accept': 'text/html' },
        timeout: 15000,
        maxRedirects: 5,
        ...(signal ? { signal } : {}),
    });

    const $ = cheerio.load(data);
    // Check for ashdi iframe (src or data-src)
    const ashdiSrc = $('iframe[src*="ashdi.vip"]').attr('src') ||
                     $('iframe[data-src*="ashdi.vip"]').attr('data-src');
    if (ashdiSrc) return { type: 'ashdi', url: ashdiSrc };

    // Check for tortuga iframe (src or data-src)
    const tortugaSrc = $('iframe[src*="tortuga.wtf"]').attr('src') ||
                       $('iframe[data-src*="tortuga.wtf"]').attr('data-src') ||
                       $('iframe[src*="tortuga.tw"]').attr('src') ||
                       $('iframe[data-src*="tortuga.tw"]').attr('data-src');
    if (tortugaSrc) return { type: 'tortuga', url: tortugaSrc };

    return null;
}

// ── Fetch player page ───────────────────────────────────────────────────

async function fetchPlayerUrl(playerUrl, type, pageUrl, title, signal) {
    const ref = pageUrl.startsWith('http') ? pageUrl : `${BASE}${pageUrl}`;
    const axiosConfig = proxyManager.getConfig('ashdi');

    if (type === 'ashdi') {
        let url = normalizeUrl(playerUrl);
        if (/\/vod\/\d+/i.test(url) && !url.includes('multivoice')) {
            url += (url.includes('?') ? '&' : '?') + 'multivoice';
        }
        const { data: html } = await axios.get(url, {
            ...axiosConfig,
            headers: { ...NAV_HEADERS, 'Referer': ref },
            timeout: 15000,
            ...(signal ? { signal } : {}),
        });
        return parsePlayer(html, title);
    } else if (type === 'tortuga') {
        const vodData = await parseTortugaVod(playerUrl);
        if (!vodData) return null;
        return [{ title: 'Original', file: vodData.file, poster: vodData.poster || null }];
    }
    return null;
}

// ── Group search results by original title ──────────────────────────────────

function groupResults(results) {
    const groups = {};
    for (const r of results) {
        const key = r.origTitle.toLowerCase().trim() || r.title.toLowerCase().trim();
        if (!groups[key]) groups[key] = { origTitle: r.origTitle, isTv: false, seasons: [], movieUrl: null };
        const season = detectSeason(r.title);
        if (season !== null) {
            groups[key].isTv = true;
            groups[key].seasons.push({ season, url: r.url, newsId: getNewsId(r.url), year: r.year });
        } else {
            // Could be a movie, or a TV season without season number in title
            // Check if the group already has seasons → if so, it's TV
            groups[key].seasons.push({ season: null, url: r.url, newsId: getNewsId(r.url), year: r.year });
        }
    }
    return Object.values(groups);
}

// ── Public API ─────────────────────────────────────────────────────────────

module.exports = {
    getLinks: async (imdbId, title, originalTitle, year, host, signal) => {
        console.log('[UAKinoBest] Searching for:', title);
        try {
            // Search by IMDB ID first, then by title
            let results = await search(imdbId && /^tt\d+$/i.test(imdbId) ? imdbId : (title || ''), signal);
            if (!results.length && title && imdbId) {
                results = await search(title, signal);
            }
            if (!results.length) return null;

            // Group results
            const groups = groupResults(results);
            if (!groups.length) return null;

            // Find best matching group
            const normT = (title || '').toLowerCase().trim();
            const normO = (originalTitle || '').toLowerCase().trim();
            let group = groups.find(g => g.origTitle.toLowerCase() === normT || g.origTitle.toLowerCase() === normO);
            if (!group) group = groups[0];

            console.log('[UAKinoBest] Matched:', group.origTitle, group.isTv ? '(TV)' : '(Movie)',
                group.seasons.length, 'seasons');

            // Try playlist endpoint FIRST for all content (movies + TV)
            const voicesMap = {};
            let hasData = false;
            for (const s of group.seasons) {
                if (!s.newsId) continue;
                const sNum = s.season || 1;
                const pl = await fetchPlaylist(s.newsId, s.url, signal);
                if (!pl || !Object.keys(pl.episodes).length) continue;
                hasData = true;

                for (const [voiceName, items] of Object.entries(pl.episodes)) {
                    if (!voicesMap[voiceName]) {
                        voicesMap[voiceName] = { title: voiceName, folder: [] };
                    }

                    if (group.isTv) {
                        // Show structure — season has episodes
                        voicesMap[voiceName].folder.push({
                            title: `Сезон ${sNum}`,
                            folder: items.map(ep => ({
                                title: `Серія ${ep.episode}`,
                                file: ep.file,
                                episode: ep.episode,
                                season: sNum,
                            }))
                        });
                    } else {
                        // Movie structure — each voice is a single source
                        // Use first item per voice (movies have 1 file per voice)
                        const src = items[0];
                        voicesMap[voiceName].folder.push({
                            title: sNum === 1 ? voiceName : `${voiceName} (${sNum})`,
                            folder: [{
                                title: voiceName,
                                file: src.file,
                                episode: 1,
                                season: 1,
                            }]
                        });
                    }
                }
            }

            if (hasData) {
                const result = Object.values(voicesMap);
                // Sort seasons within each voice
                for (const voice of result) {
                    voice.folder.sort((a, b) => {
                        const sa = parseInt(a.title.match(/\d+/)?.[0]) || 0;
                        const sb = parseInt(b.title.match(/\d+/)?.[0]) || 0;
                        return sa - sb;
                    });
                }
                console.log('[UAKinoBest] Playlist result:', result.length, 'voices');
                return result;
            }

            // Fallback: scrape movie page for player iframe
            if (!group.isTv) {
                const pageUrl = group.seasons[0]?.url;
                if (!pageUrl) return null;

                const player = await scrapeMovie(pageUrl, signal);
                if (!player) return null;

                console.log('[UAKinoBest] Fallback player:', player.type, player.url);
                const parsed = await fetchPlayerUrl(player.url, player.type, pageUrl, title, signal);
                if (!parsed || !parsed.length) return null;

                if (player.type === 'ashdi') return { _routes: { ashdi: parsed } };
                return { _routes: { tortuga: parsed } };
            }
            return null;
        } catch (e) {
            console.error('[UAKinoBest] getLinks error:', e.message);
            return null;
        }
    },
};
