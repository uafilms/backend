const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');

// ─── Klon.fun (основне джерело) ───────────────────────────────────────────────
const BASE_URL = 'https://klon.fun';
const SEARCH_URL = `${BASE_URL}/engine/ajax/controller.php?mod=search`;
const MY_PROXY = 'ashdi.aartzz.pp.ua';

// ─── Wormhole (DB з парсингу) ─────────────────────────────────────────────────
const WORMHOLE_URL = 'https://wh.lme.isroot.in';

// ─── UaTUT ────────────────────────────────────────────────────────────────────
const UATUT_URL = 'https://tv.uatut.fun/watch';

// ─── Заголовки ────────────────────────────────────────────────────────────────
const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const NAV_HEADERS = {
    'User-Agent': BASE_HEADERS['User-Agent'],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7'
};

// ─── Утиліти ──────────────────────────────────────────────────────────────────
const fix = s => typeof s === 'string' ? s.replace(/0yql3tj/g, 'oyql3tj') : s;

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

function absoluteUrl(url, base = BASE_URL) {
    if (!url) return null;
    if (url.startsWith('//')) return 'https:' + url;
    if (/^https?:\/\//i.test(url)) return url;
    return new URL(url, base).href;
}

function normalizeUrl(url) {
    if (!url || typeof url !== 'string') return url;
    let out = fix(url.trim());
    if (out.startsWith('//')) out = 'https:' + out;
    return out;
}

function isMediaUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const clean = url.split('?')[0].split('#')[0].toLowerCase();
    return (
        clean.includes('.m3u8') ||
        clean.includes('.ts') ||
        clean.includes('.m4s') ||
        clean.includes('.mp4') ||
        clean.includes('.webm') ||
        clean.includes('.mkv') ||
        clean.includes('.mp3') ||
        clean.includes('.aac') ||
        clean.includes('.vtt') ||
        clean.includes('.srt') ||
        /\/(hls|playlist|stream|video|segment)(\/|\?|$)/i.test(clean)
    );
}

function rewriteAshdiNavigationUrl(url) {
    const out = normalizeUrl(url);
    if (!out) return out;
    return out
        .replace(/https?:\/\/ashdi\.vip/gi, `https://${MY_PROXY}`)
        .replace(/https?:\/\/ashdi\.[a-z0-9.-]+/gi, `https://${MY_PROXY}`);
}

function rewriteAshdiMediaUrl(url) {
    const out = normalizeUrl(url);
    if (!out) return out;
    // VOD/Serial посилання проксюємо, CDN media (m3u8/ts/...) не чіпаємо
    if (/https?:\/\/ashdi\.vip\/(vod|serial)\//i.test(out)) {
        return out.replace(/https?:\/\/ashdi\.vip/gi, `https://${MY_PROXY}`);
    }
    return out;
}

function rewriteUrl(url, { media = false } = {}) {
    return media ? rewriteAshdiMediaUrl(url) : rewriteAshdiNavigationUrl(url);
}

function normalizeSearchQuery(imdbId, fallbackTitle) {
    if (imdbId && /^tt\d+$/i.test(imdbId)) return imdbId.trim();
    return (fallbackTitle || '').trim();
}

function cleanTitle(s) {
    return (s || '')
        .toLowerCase()
        .replace(/[''`ʼ"]/g, '')
        .replace(/ё/g, 'е')
        .replace(/[^a-z0-9а-яіїєґ\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractYearFromText(text) {
    const m = String(text || '').match(/\b(19|20)\d{2}\b/);
    return m ? parseInt(m[0], 10) : null;
}

// ─── Klon.fun логіка ──────────────────────────────────────────────────────────
async function fetchUserHash(axiosConfig) {
    const { data: html } = await axios.get(BASE_URL + '/', {
        ...axiosConfig,
        headers: { ...NAV_HEADERS, 'Referer': BASE_URL + '/' },
        timeout: 15000
    });

    const hash =
        html.match(/(?:dle_login_hash|user_hash)\s*=\s*'([^']+)'/)?.[1] ||
        html.match(/name="user_hash"\s+value="([^"]+)"/)?.[1];

    return hash || null;
}

async function searchTitle(query, axiosConfig) {
    const userHash = await fetchUserHash(axiosConfig);
    if (!userHash) return [];

    const form = new URLSearchParams({
        query,
        skin: 'klontv',
        user_hash: userHash
    });

    const { data: html } = await axios.post(SEARCH_URL, form.toString(), {
        ...axiosConfig,
        headers: {
            ...NAV_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': BASE_URL,
            'Referer': BASE_URL + '/'
        },
        timeout: 15000
    });

    const $ = cheerio.load(html);
    const results = [];

    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;

        const title =
            $(el).find('.searchheading').text().trim() ||
            $(el).text().trim();

        if (!title) return;
        if (!/\.html(?:\?|$)/i.test(href)) return;
        if (/do=search|subaction=search|mode=advanced/i.test(href)) return;

        results.push({ title, url: absoluteUrl(href) });
    });

    const uniq = new Map();
    for (const item of results) {
        if (!uniq.has(item.url)) uniq.set(item.url, item);
    }

    return [...uniq.values()];
}

function scoreResult(item, fallbackTitle, year, imdbId) {
    let score = 0;

    const itemTitle = cleanTitle(item.title);
    const targetTitle = cleanTitle(fallbackTitle);
    const itemYear = extractYearFromText(item.title) || extractYearFromText(item.url);

    if (imdbId && /^tt\d+$/i.test(imdbId)) score += 100;

    if (targetTitle && itemTitle === targetTitle) score += 80;
    else if (targetTitle && itemTitle.includes(targetTitle)) score += 45;
    else if (targetTitle) {
        const targetWords = targetTitle.split(' ').filter(Boolean);
        const matched = targetWords.filter(w => itemTitle.includes(w)).length;
        score += matched * 6;
    }

    if (year && itemYear && Number(year) === Number(itemYear)) score += 35;

    if (/\/serialy\//i.test(item.url)) score += 3;
    if (/\/filmy\//i.test(item.url)) score += 3;
    if (/\/multfilmy\//i.test(item.url)) score += 3;

    return score;
}

async function findBestPostUrl(imdbId, fallbackTitle, year, axiosConfig) {
    const query = normalizeSearchQuery(imdbId, fallbackTitle);
    if (!query) return null;

    const results = await searchTitle(query, axiosConfig);
    if (!results.length) return null;

    results.sort((a, b) =>
        scoreResult(b, fallbackTitle, year, imdbId) -
        scoreResult(a, fallbackTitle, year, imdbId)
    );

    return results[0]?.url || null;
}

async function getIframe(postUrl, axiosConfig) {
    try {
        const { data: html } = await axios.get(postUrl, {
            ...axiosConfig,
            headers: { ...NAV_HEADERS, 'Referer': BASE_URL + '/' },
            timeout: 15000
        });

        const $ = cheerio.load(html);

        let src =
            $('iframe[data-src*="ashdi.vip"]').attr('data-src') ||
            $('iframe[src*="ashdi.vip"]').attr('src') ||
            $('iframe[data-src*="ashdi"]').attr('data-src') ||
            $('iframe[src*="ashdi"]').attr('src') ||
            $('iframe[data-src]').attr('data-src') ||
            $('iframe[src]').attr('src');

        if (!src) return null;

        src = absoluteUrl(src, postUrl);
        src = rewriteUrl(src, { media: false });

        if (/\/vod\/\d+/i.test(src) && !src.includes('multivoice')) {
            src += (src.includes('?') ? '&' : '?') + 'multivoice';
        }

        return src;
    } catch (e) {
        console.error('[Ashdi/Klon] getIframe error:', e.message);
        return null;
    }
}

// ─── Парсер плеєра (спільний для всіх джерел) ────────────────────────────────
function parsePlayer(html, fallbackTitle) {
    const mainVoiceId = (
        html.match(/\bid\s*[:=]\s*["']videoplayer(\d+)["']/i)?.[1] ||
        html.match(/\bid\s*=\s*["']videoplayer(\d+)["']/i)?.[1] ||
        null
    );

    const posterMatch = html.match(/poster\s*:\s*['"]([^'"]+)['"]/);
    const globalPoster = posterMatch ? rewriteUrl(posterMatch[1], { media: true }) : null;

    const subMatch = html.match(/subtitle\s*:\s*['"]([^'"]+)['"]/);
    const globalSubtitle = subMatch ? rewriteUrl(subMatch[1], { media: true }) : null;

    let rawMatch = html.match(/file\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/s);

    if (!rawMatch) {
        const arrMatch = html.match(/file\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
        if (arrMatch) rawMatch = [arrMatch[0], null, arrMatch[1]];
    }

    if (!rawMatch) {
        const arrMatch2 = html.match(/file\s*:\s*(\[[\s\S]*\])/);
        if (arrMatch2) rawMatch = [arrMatch2[0], null, arrMatch2[1]];
    }

    if (!rawMatch) {
        const objMatch = html.match(/file\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
        if (objMatch) rawMatch = [objMatch[0], null, objMatch[1]];
    }

    if (!rawMatch) return null;

    let raw = rawMatch[2];
    if (!raw) return null;

    raw = raw.replace(/\\'/g, "'").replace(/\\"/g, '"');
    let parsed = safeParse(raw);

    if (typeof parsed === 'string') {
        const t = (fallbackTitle || '').trim();
        return [{
            title: t,
            name: t,
            file: rewriteUrl(parsed, { media: true }),
            poster: globalPoster,
            subtitle: globalSubtitle
        }];
    }

    if (Array.isArray(parsed) && parsed[0]?.file) {
        const sorted = mainVoiceId
            ? [...parsed].sort((a, b) => {
                const aMain = String(a?.id ?? '') === String(mainVoiceId);
                const bMain = String(b?.id ?? '') === String(mainVoiceId);
                if (aMain && !bMain) return -1;
                if (!aMain && bMain) return 1;
                return 0;
            })
            : parsed;

        return sorted.map(i => ({
            title: (i.title || fallbackTitle || '').trim(),
            name: (i.title || fallbackTitle || '').trim(),
            file: rewriteUrl(i.file, { media: true }),
            poster: rewriteUrl(i.poster, { media: true }) || globalPoster,
            subtitle: rewriteUrl(i.subtitle, { media: true }) || globalSubtitle,
            voiceId: i.id != null ? String(i.id) : undefined
        }));
    }

    const results = [];

    function walk(node, ctx = {}) {
        if (!node) return;

        if (node.title && !ctx.dub) {
            ctx = { ...ctx, dub: String(node.title).trim() };
        }

        if (/сезон|season/i.test(node.title || '')) {
            const m = String(node.title).match(/(\d+)/);
            if (m) ctx = { ...ctx, season: parseInt(m[1], 10) };
        }

        if (/серія|серiя|episode|ep\b|e\b/i.test(node.title || '')) {
            const m = String(node.title).match(/(\d+)/);
            if (m) ctx = { ...ctx, episode: parseInt(m[1], 10) };
        }

        if (node.file && typeof node.file === 'string') {
            results.push({
                title: node.title?.trim() || fallbackTitle,
                name: ctx.dub || fallbackTitle,
                file: rewriteUrl(node.file, { media: true }),
                poster: rewriteUrl(node.poster, { media: true }) || globalPoster,
                subtitle: rewriteUrl(node.subtitle, { media: true }) || globalSubtitle,
                voiceId: node.id != null ? String(node.id) : undefined,
                season: ctx.season,
                episode: ctx.episode
            });
        }

        if (Array.isArray(node.folder)) {
            node.folder.forEach(child => walk(child, { ...ctx }));
        }
    }

    if (Array.isArray(parsed)) {
        parsed.forEach(root => walk(root));
    } else if (parsed && typeof parsed === 'object') {
        walk(parsed);
    }

    if (!results.length) return null;

    if (mainVoiceId) {
        results.sort((a, b) => {
            const aMain = String(a?.voiceId ?? '') === String(mainVoiceId);
            const bMain = String(b?.voiceId ?? '') === String(mainVoiceId);
            if (aMain && !bMain) return -1;
            if (!aMain && bMain) return 1;
            return 0;
        });
    }

    return results;
}

// ─── Отримання посилань за прямим URL ashdi ───────────────────────────────────
async function getLinksFromAshdiUrl(ashdiUrl, title, signal) {
    const axiosConfig = { ...proxyManager.getConfig('ashdi'), ...(signal ? { signal } : {}) };
    try {
        let url = normalizeUrl(ashdiUrl);
        url = rewriteUrl(url, { media: false });
        if (/\/vod\/\d+/i.test(url) && !url.includes('multivoice')) {
            url += (url.includes('?') ? '&' : '?') + 'multivoice';
        }
        const html = (await axios.get(url, {
            ...axiosConfig,
            headers: { 'User-Agent': BASE_HEADERS['User-Agent'] },
            timeout: 15000
        })).data;
        return parsePlayer(html, title);
    } catch (e) {
        if (axios.isCancel(e)) return null;
        console.error('[Ashdi] getLinksFromAshdiUrl error:', e.message);
        return null;
    }
}

// ─── Джерело 1: Klon.fun ──────────────────────────────────────────────────────
async function getFromKlonFun(imdbId, title, year, signal) {
    const axiosConfig = { ...proxyManager.getConfig('ashdi'), ...(signal ? { signal } : {}) };
    try {
        const postUrl = await findBestPostUrl(imdbId, title, year, axiosConfig);
        if (!postUrl) return null;

        const iframe = await getIframe(postUrl, axiosConfig);
        if (!iframe) return null;

        const html = (await axios.get(iframe, {
            ...axiosConfig,
            headers: { 'User-Agent': BASE_HEADERS['User-Agent'] },
            timeout: 15000
        })).data;

        return parsePlayer(html, title);
    } catch (e) {
        if (axios.isCancel(e)) return null;
        console.error('[Ashdi/Klon] getFromKlonFun error:', e.message);
        return null;
    }
}

// ─── Джерело 2: Wormhole ──────────────────────────────────────────────────────
async function getFromWormhole(imdbId, title, signal) {
    if (!imdbId) return null;
    try {
        const { data } = await axios.get(`${WORMHOLE_URL}/?imdb_id=${imdbId}`, {
            headers: BASE_HEADERS,
            timeout: 10000,
            ...(signal ? { signal } : {})
        });

        const ashdiUrl = data?.play;
        if (!ashdiUrl || typeof ashdiUrl !== 'string' || !ashdiUrl.includes('ashdi')) return null;

        return await getLinksFromAshdiUrl(ashdiUrl, title, signal);
    } catch (e) {
        if (axios.isCancel(e)) return null;
        console.error('[Ashdi/Wormhole] error:', e.message);
        return null;
    }
}

// ─── Джерело 3: UaTUT ─────────────────────────────────────────────────────────
async function getFromUaTUT(imdbId, title, signal) {
    try {
        const query = imdbId || title;
        if (!query) return null;

        const { data: results } = await axios.get(
            `${UATUT_URL}/search.php?q=${encodeURIComponent(query)}`,
            {
                headers: BASE_HEADERS,
                timeout: 10000,
                ...(signal ? { signal } : {})
            }
        );

        if (!Array.isArray(results) || !results.length) return null;

        const match = imdbId
            ? (results.find(r => r.imdb_id === imdbId) || results[0])
            : results[0];

        if (!match?.id) return null;

        const { data: html } = await axios.get(`${UATUT_URL}/${match.id}`, {
            headers: BASE_HEADERS,
            timeout: 10000,
            ...(signal ? { signal } : {})
        });

        const $ = cheerio.load(html);
        const ashdiSrc = $('iframe[src*="ashdi.vip"]').attr('src');
        if (!ashdiSrc) return null;

        return await getLinksFromAshdiUrl(ashdiSrc, title || match.title, signal);
    } catch (e) {
        if (axios.isCancel(e)) return null;
        console.error('[Ashdi/UaTUT] error:', e.message);
        return null;
    }
}

// ─── Multirequest: перший результат перемагає ────────────────────────────────
function raceFirst(tasks) {
    return new Promise((resolve) => {
        const controller = new AbortController();
        const { signal } = controller;

        let remaining = tasks.length;
        let resolved = false;

        if (remaining === 0) {
            resolve(null);
            return;
        }

        tasks.forEach(task => {
            task(signal)
                .then(result => {
                    if (resolved) return;
                    if (result && Array.isArray(result) && result.length > 0) {
                        resolved = true;
                        controller.abort();
                        resolve(result);
                    } else {
                        remaining--;
                        if (remaining === 0 && !resolved) resolve(null);
                    }
                })
                .catch(() => {
                    remaining--;
                    if (remaining === 0 && !resolved) resolve(null);
                });
        });
    });
}

// ─── Публічний API ────────────────────────────────────────────────────────────
module.exports = {
    getLinksFromAshdiUrl,

    getLinks: async (imdbId, title, year = null) => {
        return raceFirst([
            signal => getFromWormhole(imdbId, title, signal),
            signal => getFromUaTUT(imdbId, title, signal),
            signal => getFromKlonFun(imdbId, title, year, signal)
        ]);
    }
};
