// Site: uaserials.my → Provider: HDVB
// Delegates HDVB iframe parsing to hdvb.js

const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');
const { parseHdvbIframe } = require('./hdvb');

const BASE = 'https://uaserials.my';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:149.0) Gecko/20100101 Firefox/149.0';

const HEADERS = { 'User-Agent': UA };

// ── Step 1: search ────────────────────────────────────────────────────────────

async function search(query, axiosConfig) {
    const params = new URLSearchParams({
        do: 'search', subaction: 'search', search_start: '0',
        full_search: '0', story: query,
    }).toString();

    const { data } = await axios.get(`${BASE}/index.php?${params}`, {
        headers: HEADERS, timeout: 15000, ...axiosConfig,
    });

    const html = typeof data === 'string' ? data : '';
    const results = [];
    const re = /<a class="short-img[^"]*" href="([^"]+)"[\s\S]*?<div class="th-title[^"]*"[^>]*>([^<]+)<\/div>\s*<div class="th-title-oname[^"]*"[^>]*>([^<]+)<\/div>/g;
    let m;
    while ((m = re.exec(html))) {
        results.push({ url: m[1], title: m[2].trim(), oname: m[3].trim() });
    }
    return results;
}

// ── Step 2: get HDVB iframe URLs from movie/series page ───────────────────────

async function getVods(pageUrl, axiosConfig) {
    const { data: body } = await axios.get(pageUrl, {
        headers: HEADERS, timeout: 15000, ...axiosConfig,
    });

    const html = typeof body === 'string' ? body : '';
    const iframes = [];

    // Primary pattern: video_box divs containing iframe with data-src or src
    const iframeRe = /<div class="video_box tabs_b[^"]*">[\s\S]*?<iframe[^>]+(?:data-src|src)="([^"]+)"[^>]*title="([^"]*)"/g;
    let im;
    while ((im = iframeRe.exec(html))) {
        iframes.push({ url: im[1], label: im[2] || 'Player' });
    }

    // Fallback: any iframe with hdvb URL (for series pages without video_box)
    if (!iframes.length) {
        const simpleRe = /<iframe[^>]+(?:data-src|src)="([^"]+)"[^>]*title="([^"]*)"/g;
        let sm;
        while ((sm = simpleRe.exec(html))) {
            if (sm[1].includes('hdvb') || sm[1].includes('hdvbua')) {
                iframes.push({ url: sm[1], label: sm[2] || 'Player' });
            }
        }
    }

    // Last fallback: just hdvb URLs anywhere
    if (!iframes.length) {
        const hdvbRe = /https?:\/\/[^"'\s]*hdvb[^"'\s]+/g;
        let hr;
        while ((hr = hdvbRe.exec(html))) {
            iframes.push({ url: hr[0], label: 'HDVB' });
        }
    }

    return iframes.filter(v => !/трейлер/i.test(v.label) && !/\/trailer\//i.test(v.url));
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
    getLinks: async (title, originalTitle, year) => {
        const axiosConfig = proxyManager.getConfig('uaserials-my');
        try {
            // Step 1: search
            const query = title || originalTitle;
            if (!query) return null;

            let results = await search(query, axiosConfig);
            if (!results.length && originalTitle && originalTitle !== title) {
                results = await search(originalTitle, axiosConfig);
            }
            if (!results.length) return null;

            // Step 2: pick best match
            const normalizeStr = s => (s || '').trim().toLowerCase();
            const target = results.find(r =>
                normalizeStr(r.title) === normalizeStr(title) ||
                (originalTitle && normalizeStr(r.oname) === normalizeStr(originalTitle))
            ) || results.find(r =>
                normalizeStr(r.title).includes(normalizeStr(title)) ||
                (originalTitle && normalizeStr(r.oname).includes(normalizeStr(originalTitle)))
            ) || results[0];
            if (!target) return null;

            // Step 3: get VOD iframes
            const iframes = await getVods(target.url, axiosConfig);
            if (!iframes.length) return null;

            // Step 4: parse HDVB iframes using hdvb.js parser
            let hdvbData = null;
            for (const iframe of iframes) {
                try {
                    const parsed = await parseHdvbIframe(iframe.url, `${BASE}/`);
                    if (parsed) {
                        hdvbData = parsed;
                        break;
                    }
                } catch (e) {
                    console.error('[UaSerialsMy] HDVB iframe parse error:', e.message);
                }
            }

            if (!hdvbData) return null;

            // Filter out invalid results
            const valid = Array.isArray(hdvbData)
                ? hdvbData.filter(item => item && (item.file || item.folder))
                : (hdvbData.file || hdvbData.folder ? hdvbData : null);
            if (!valid || (Array.isArray(valid) && !valid.length)) return null;

            return { _routes: { hdvb: Array.isArray(valid) ? valid : [valid] } };
        } catch (e) {
            console.error('[UaSerialsMy] getLinks error:', e.message);
            return null;
        }
    }
};
