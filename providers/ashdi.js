const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');

// ─── Constants ────────────────────────────────────────────────────────────────
const MY_PROXY = 'ashdi.aartzz.pp.ua';

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const NAV_HEADERS = {
    'User-Agent': BASE_HEADERS['User-Agent'],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7'
};

// ─── Utilities ────────────────────────────────────────────────────────────────
const fix = s => typeof s === 'string' ? s.replace(/0yql3tj/g, 'oyql3tj') : s;

function safeParse(str) {
    if (!str) return null;
    try { return JSON.parse(str); } catch (e) {
        try { return new Function('return ' + str)(); } catch { return null; }
    }
}

function absoluteUrl(url, base) {
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
        clean.includes('.m3u8') || clean.includes('.ts') || clean.includes('.m4s') ||
        clean.includes('.mp4') || clean.includes('.webm') || clean.includes('.mkv') ||
        clean.includes('.mp3') || clean.includes('.aac') || clean.includes('.vtt') ||
        clean.includes('.srt') || /\/(hls|playlist|stream|video|segment)(\/|\?|$)/i.test(clean)
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
    if (/https?:\/\/ashdi\.vip\/(vod|serial)\//i.test(out)) {
        return out.replace(/https?:\/\/ashdi\.vip/gi, `https://${MY_PROXY}`);
    }
    return out;
}

function rewriteUrl(url, { media = false } = {}) {
    return media ? rewriteAshdiMediaUrl(url) : rewriteAshdiNavigationUrl(url);
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

// ─── VOD Parser (shared by all Ashdi sources) ─────────────────────────────────

function parsePlayer(html, fallbackTitle, fallbackPoster = null) {
    const mainVoiceId = (
        html.match(/\bid\s*[:=]\s*["']videoplayer(\d+)["']/i)?.[1] ||
        html.match(/\bid\s*=\s*["']videoplayer(\d+)["']/i)?.[1] || null
    );

    const posterMatch = html.match(/poster\s*:\s*["']([^"']+)["']/);
    const globalPoster = posterMatch ? rewriteUrl(posterMatch[1], { media: true }) : fallbackPoster;
    
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

    // If raw is a URL string (not JSON), use it directly
    if (!parsed && /^https?:\/\//i.test(raw)) {
        const t = (fallbackTitle || '').trim();
        return [{ title: t, name: t, file: rewriteUrl(raw, { media: true }), poster: globalPoster, subtitle: globalSubtitle }];
    }

    if (typeof parsed === 'string') {
        const t = (fallbackTitle || '').trim();
        return [{ title: t, name: t, file: rewriteUrl(parsed, { media: true }), poster: globalPoster, subtitle: globalSubtitle }];
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
        if (node.title && !ctx.dub) ctx = { ...ctx, dub: String(node.title).trim() };
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
        if (Array.isArray(node.folder)) node.folder.forEach(child => walk(child, { ...ctx }));
    }
    if (Array.isArray(parsed)) parsed.forEach(root => walk(root));
    else if (parsed && typeof parsed === 'object') walk(parsed);

    if (!results.length) return null;
    if (mainVoiceId) results.sort((a, b) => {
        const aMain = String(a?.voiceId ?? '') === String(mainVoiceId);
        const bMain = String(b?.voiceId ?? '') === String(mainVoiceId);
        if (aMain && !bMain) return -1;
        if (!aMain && bMain) return 1;
        return 0;
    });
    return results;
}

// ─── Public: parse Ashdi iframe URL ───────────────────────────────────────────

async function getLinksFromAshdiUrl(ashdiUrl, title, signal, fallbackPoster = null) {
    const axiosConfig = { ...proxyManager.getConfig('ashdi'), ...(signal ? { signal } : {}) };
    try {
        let url = normalizeUrl(ashdiUrl);
        url = rewriteUrl(url, { media: false });
        if (/\/vod\/\d+/i.test(url) && !url.includes('multivoice')) {
            url += (url.includes('?') ? '&' : '?') + 'multivoice';
        }
        const html = (await axios.get(url, {
            ...axiosConfig,
            headers: {
                ...NAV_HEADERS,
                'Referer': 'https://kinoukr.tv/',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 15000
        })).data;
        return parsePlayer(html, title, fallbackPoster);
    } catch (e) {
        if (axios.isCancel(e)) return null;
        console.error('[Ashdi] getLinksFromAshdiUrl error:', e.message);
        return null;
    }
}

// ─── Multirequest utility ─────────────────────────────────────────────────────

function raceFirst(tasks) {
    return new Promise((resolve) => {
        const controller = new AbortController();
        const { signal } = controller;
        let remaining = tasks.length;
        let resolved = false;
        if (remaining === 0) { resolve(null); return; }
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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    getLinksFromAshdiUrl,
    parsePlayer,
    rewriteUrl,
    normalizeUrl,
    absoluteUrl,
    cleanTitle,
    extractYearFromText,
    raceFirst,
    BASE_HEADERS,
    NAV_HEADERS,
    MY_PROXY,
};
