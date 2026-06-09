// Site: uaserials.com → Provider: Tortuga
// Decrypts AES-encrypted player data, delegates transformation to tortuga.js

const axios = require('axios');
const crypto = require('crypto');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');
const { transformTortugaPlayers } = require('./tortuga');

const BASE = 'https://uaserials.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:149.0) Gecko/20100101 Firefox/149.0';

const HEADERS = {
    'User-Agent': UA,
};

// ── AES decryption (matches CryptoJSAesDecrypt from tools.min.js) ─────────────

function aesDecrypt(passphrase, jsonStr) {
    const parsed = JSON.parse(jsonStr);
    const salt = Buffer.from(parsed.salt, 'hex');
    const iv = Buffer.from(parsed.iv, 'hex');
    // CryptoJS PBKDF2 with SHA-512, keySize 8 (8 words = 32 bytes), 999 iterations
    const key = crypto.pbkdf2Sync(passphrase, salt, 999, 32, 'sha512');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(parsed.ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ── Module-level passphrase cache ─────────────────────────────────────────────

let _passphraseCache = null;

// ── Step 1: extract passphrase from page JS files ────────────────────────────
// The passphrase was in player.min.js but is now in a hashed filename.
// We auto-discover it by scanning all JS scripts loaded on the page.

async function getPassphrase(axiosConfig, signal) {
    if (_passphraseCache) return _passphraseCache;

    // Fetch homepage to discover which JS files are loaded
    const { data: html } = await axios.get(BASE + '/', {
        headers: HEADERS,
        timeout: 15000,
        ...axiosConfig,
        ...(signal ? { signal } : {}),
    });

    // Extract all <script src="..."> URLs pointing to .js files
    const scriptSrcs = [];
    const srcRe = /<script[^>]+src="([^"]+\.js[^"]*)"/g;
    let m;
    while ((m = srcRe.exec(html))) {
        const url = m[1].startsWith('http') ? m[1] :
            (m[1].startsWith('/') ? `${BASE}${m[1]}` : `${BASE}/${m[1]}`);
        scriptSrcs.push(url);
    }

    console.log('[UaSerialsCom] Scanning', scriptSrcs.length, 'JS files for passphrase');

    // Scan each JS file for var dd=... pattern
    for (const url of scriptSrcs) {
        try {
            const { data: js } = await axios.get(url, {
                headers: HEADERS,
                timeout: 10000,
                ...axiosConfig,
                ...(signal ? { signal } : {}),
            });

            const ddMatch = js.match(/var dd=([^;]+);/);
            if (!ddMatch) continue;

            const expr = ddMatch[1].trim();
            console.log('[UaSerialsCom] Found dd= in', url.substring(url.lastIndexOf('/') + 1));

            // Case 1: Simple string concatenation: 'ABC'+'DEF'+'12'
            const strMatch = expr.match(/^'([^']*)'(?:\+'([^']*)')*$/);
            if (strMatch) {
                const passphrase = expr.replace(/'/g, '').split('+').join('');
                console.log('[UaSerialsCom] Passphrase extracted (string concat)');
                _passphraseCache = passphrase;
                return passphrase;
            }

            // Case 2: Obfuscated function call: _0x...(...)+'12'
            // Full eval-based extraction kept for compatibility
            const callMatch = expr.match(/(_0x\w+)\(([-\w.,x]+)\)\+'(\d+)'/);
            if (callMatch) {
                const [, funcName, argsStr, suffix] = callMatch;

                const helperStart = js.indexOf(`function ${funcName}(`);
                if (helperStart === -1) continue;

                let hDepth = 0, hEnd = helperStart;
                for (; hEnd < js.length; hEnd++) {
                    if (js[hEnd] === '{') hDepth++;
                    if (js[hEnd] === '}') { hDepth--; if (hDepth === 0) break; }
                }

                const b9bfStart = js.indexOf('function _0xb9bf()');
                const b9bfEnd = js.indexOf('return _0xb9bf();}', b9bfStart) + 'return _0xb9bf();}'.length;
                const b9bf = js.substring(b9bfStart, b9bfEnd);

                const shufflerCloseIdx = js.indexOf(')(_0xb9bf,');
                let depth = 1;
                let i = shufflerCloseIdx + ')(_0xb9bf,'.length;
                while (i < js.length && depth > 0) {
                    if (js[i] === '(') depth++;
                    if (js[i] === ')') depth--;
                    i++;
                }
                const shuffler = js.substring(0, i + 1);

                const x3514Start = js.indexOf('function _0x3514(');
                const x3514End = js.indexOf('return _0x2439bb;}', x3514Start) + 'return _0x2439bb;}'.length;
                const x3514 = js.substring(x3514Start, x3514End);

                const helper = js.substring(helperStart, hEnd + 1);

                const code = `${b9bf}\n${shuffler}\n${x3514}\n${helper}\n` +
                    `RESULT = ${funcName}(${argsStr}) + '${suffix}';`;

                let RESULT;
                eval(code);
                console.log('[UaSerialsCom] Passphrase extracted (eval)');
                _passphraseCache = RESULT;
                return RESULT;
            }

            console.log('[UaSerialsCom] Unknown dd= pattern in', url, ':', expr.substring(0, 50));
        } catch (e) {
            // skip files that fail to load
        }
    }

    throw new Error('[UaSerialsCom] Passphrase not found in any page JS file');
}

// ── Step 2: search ────────────────────────────────────────────────────────────

async function search(query, axiosConfig, signal) {
    const payload = new URLSearchParams({
        do: 'search',
        subaction: 'search',
        search_start: '0',
        result_from: '1',
        story: query,
    }).toString();

    const { data } = await axios.post(
        `${BASE}/index.php?do=search`,
        payload,
        {
            headers: {
                ...HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': BASE,
                'Referer': `${BASE}/series/`,
            },
            timeout: 15000,
            ...axiosConfig,
            ...(signal ? { signal } : {}),
        }
    );

    const html = typeof data === 'string' ? data : '';
    const $ = cheerio.load(html);
    const results = [];

    // New site design: search results use uas-card structure
    $('a.uas-card[data-uas-type="post"]').each((i, el) => {
        const href = $(el).attr('href');
        const title = $(el).find('.uas-card__title').text().trim();
        const oname = $(el).find('.uas-card__orig').text().trim();
        if (href && title) {
            // href can be absolute or relative
            const url = href.startsWith('http') ? href : `${BASE}${href}`;
            results.push({ url, title, oname });
        }
    });

    // Fallback: old design with short-img/th-title classes
    if (!results.length) {
        const re = /<a class="short-img[^"]*" href="([^"]+)"[\s\S]*?<div class="th-title[^"]*"[^>]*>([^<]+)<\/div>\s*<div class="th-title-oname[^"]*"[^>]*>([^<]+)<\/div>/g;
        let m;
        while ((m = re.exec(html))) {
            results.push({ url: m[1], title: m[2].trim(), oname: m[3].trim() });
        }
    }

    return results;
}

// ── Step 3: get VODs (decrypt data-tag attributes) ────────────────────────────

async function getVods(pageUrl, passphrase, axiosConfig, signal) {
    const { data: body } = await axios.get(pageUrl, {
        headers: HEADERS,
        timeout: 15000,
        ...axiosConfig,
        ...(signal ? { signal } : {}),
    });

    const html = typeof body === 'string' ? body : '';

    // Extract encrypted data-tag attributes
    const tags = [];
    const tagRe = /data-tag\d+='(\{[^']+\})'/g;
    let tm;
    while ((tm = tagRe.exec(html))) {
        tags.push(tm[1]);
    }

    if (!tags.length) return [];

    // Decrypt each tag and merge
    const players = [];
    for (const tag of tags) {
        try {
            const decrypted = aesDecrypt(passphrase, tag);
            const data = JSON.parse(decrypted.replace(/\\/g, ''));
            // Tortuga changed URL format from /vod/ to /usp/
            for (const p of data) {
                if (p.url) p.url = p.url.replace('/usp/', '/vod/');
            }
            players.push(...data);
        } catch (e) {
            // skip invalid/unreadable tags
        }
    }

    // Filter out trailers
    return players.filter(p => !/трейлер/i.test(p.tabName || ''));
}

// ── Result matching helpers ───────────────────────────────────────────────────

function normalizeStr(s) {
    return (s || '').trim().toLowerCase();
}

function pickBestResult(results, title, originalTitle, year) {
    // Try exact title match
    const exact = results.find(r =>
        normalizeStr(r.title) === normalizeStr(title) ||
        (originalTitle && normalizeStr(r.oname) === normalizeStr(originalTitle))
    );
    if (exact) return exact;

    // Try partial match
    const partial = results.find(r =>
        normalizeStr(r.title).includes(normalizeStr(title)) ||
        (originalTitle && normalizeStr(r.oname).includes(normalizeStr(originalTitle)))
    );
    return partial || results[0];
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
    getLinks: async (title, originalTitle, year, type, signal) => {
        console.log('[UaSerialsCom] Searching for:', title);
        // Only process movies — TV series return VOD URLs we can't play
        if (type && type === 'tv') return null;
        
        const axiosConfig = proxyManager.getConfig('uaserials-com');
        try {
            // Step 1: get passphrase
            const passphrase = await getPassphrase(axiosConfig, signal);

            // Step 2: search
            const query = title || originalTitle;
            if (!query) return null;

            let results = await search(query, axiosConfig, signal);

            // Fallback: try original title
            if (!results.length && originalTitle && originalTitle !== title) {
                results = await search(originalTitle, axiosConfig, signal);
            }

            if (!results.length) return null;

            // Step 3: pick best match
            const target = pickBestResult(results, title, originalTitle, year);
            if (!target) return null;

            // Step 4: get VODs
            const players = await getVods(target.url, passphrase, axiosConfig, signal);
            if (!players.length) return null;

            // Step 5: transform to folder/file format using tortuga.js
            const result = await transformTortugaPlayers(players, signal);
            if (!result) return null;
            return result;
        } catch (e) {
            console.error('[UaSerialsCom] getLinks error:', e.message);
            return null;
        }
    }
};
