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

// ── Step 1: extract passphrase from player.min.js (uses eval for obfuscation) ─

async function getPassphrase(axiosConfig) {
    const { data: d } = await axios.get(
        `${BASE}/templates/uaserials2020/js/player.min.js?v4`,
        { headers: HEADERS, timeout: 15000, ...axiosConfig }
    );

    // Find the dd= assignment pattern: var dd=OBFUSCATED_CALL+'12';
    const ddMatch = d.match(/var dd=([^;]+);/);
    if (!ddMatch) throw new Error('[UaSerialsCom] dd assignment not found in player.min.js');

    // Extract the obfuscated call: e.g. _0x427b34(-0xc3,-0x12a,-0xf7)+'12'
    const callMatch = ddMatch[1].match(/(_0x\w+)\(([-\w.,x]+)\)\+'(\d+)'/);
    if (!callMatch) throw new Error('[UaSerialsCom] Cannot parse dd expression: ' + ddMatch[1]);

    const [, funcName, argsStr, suffix] = callMatch;

    // Find the helper function (e.g. _0x427b34) which calls _0x3514
    const helperStart = d.indexOf(`function ${funcName}(`);
    if (helperStart === -1) throw new Error(`[UaSerialsCom] Helper function ${funcName} not found`);

    // Brace-count to find function end
    let hDepth = 0, hEnd = helperStart;
    for (; hEnd < d.length; hEnd++) {
        if (d[hEnd] === '{') hDepth++;
        if (d[hEnd] === '}') { hDepth--; if (hDepth === 0) break; }
    }

    // Extract _0xb9bf, the shuffler IIFE, _0x3514, and the helper
    const b9bfStart = d.indexOf('function _0xb9bf()');
    const b9bfEnd = d.indexOf('return _0xb9bf();}', b9bfStart) + 'return _0xb9bf();}'.length;
    const b9bf = d.substring(b9bfStart, b9bfEnd);

    // Shuffler IIFE ends with )(_0xb9bf, NUMBER);
    const shufflerCloseIdx = d.indexOf(')(_0xb9bf,');
    let depth = 1;
    let i = shufflerCloseIdx + ')(_0xb9bf,'.length;
    while (i < d.length && depth > 0) {
        if (d[i] === '(') depth++;
        if (d[i] === ')') depth--;
        i++;
    }
    const shuffler = d.substring(0, i + 1);

    // _0x3514 decoder
    const x3514Start = d.indexOf('function _0x3514(');
    const x3514End = d.indexOf('return _0x2439bb;}', x3514Start) + 'return _0x2439bb;}'.length;
    const x3514 = d.substring(x3514Start, x3514End);

    const helper = d.substring(helperStart, hEnd + 1);

    // Evaluate to extract the passphrase (eval is required for obfuscation)
    const code = `${b9bf}\n${shuffler}\n${x3514}\n${helper}\n` +
        `RESULT = ${funcName}(${argsStr}) + '${suffix}';`;

    let RESULT;
    eval(code); // eslint-disable-line no-eval
    return RESULT;
}

// ── Step 2: search ────────────────────────────────────────────────────────────

async function search(query, axiosConfig) {
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
        }
    );

    const html = typeof data === 'string' ? data : '';
    const results = [];
    const re = /<a class="short-img[^"]*" href="([^"]+)"[\s\S]*?<div class="th-title[^"]*"[^>]*>([^<]+)<\/div>\s*<div class="th-title-oname[^"]*"[^>]*>([^<]+)<\/div>/g;
    let m;
    while ((m = re.exec(html))) {
        results.push({ url: m[1], title: m[2].trim(), oname: m[3].trim() });
    }
    return results;
}

// ── Step 3: get VODs (decrypt data-tag attributes) ────────────────────────────

async function getVods(pageUrl, passphrase, axiosConfig) {
    const { data: body } = await axios.get(pageUrl, {
        headers: HEADERS,
        timeout: 15000,
        ...axiosConfig,
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
    getLinks: async (title, originalTitle, year, type) => {
        // Only process movies — TV series return VOD URLs we can't play
        if (type && type === 'tv') return null;
        
        const axiosConfig = proxyManager.getConfig('uaserials-com');
        try {
            // Step 1: get passphrase
            const passphrase = await getPassphrase(axiosConfig);

            // Step 2: search
            const query = title || originalTitle;
            if (!query) return null;

            let results = await search(query, axiosConfig);

            // Fallback: try original title
            if (!results.length && originalTitle && originalTitle !== title) {
                results = await search(originalTitle, axiosConfig);
            }

            if (!results.length) return null;

            // Step 3: pick best match
            const target = pickBestResult(results, title, originalTitle, year);
            if (!target) return null;

            // Step 4: get VODs
            const players = await getVods(target.url, passphrase, axiosConfig);
            if (!players.length) return null;

            // Step 5: transform to folder/file format using tortuga.js
            const result = await transformTortugaPlayers(players);
            if (!result) return null;
            return result;
        } catch (e) {
            console.error('[UaSerialsCom] getLinks error:', e.message);
            return null;
        }
    }
};
