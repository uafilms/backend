// Site: tortuga.tw → Provider: Tortuga
// Parses /vod/XXXX (movies) and /embed/XXXX (TV series) pages
// Decodes XOR-encrypted file/poster values to get actual m3u8 links
// Algorithm reverse-engineered from tor.core.min.js (XOR + first-byte key)

const axios = require('axios');
const proxyManager = require('../utils/proxyManager');

function _xorKey(n, i) {
    return (n + i * 7 + 13) % 256;
}

function decodeTortugaFile(encoded) {
    if (!encoded || encoded.trim() === '') return null;
    try {
        const clean = encoded.replace(/==+$/, '');
        const raw = Buffer.from(clean, 'base64').toString('binary');
        if (raw.length < 2) return null;
        const key = raw.charCodeAt(0);
        let out = '';
        for (let i = 1; i < raw.length; i++) {
            out += String.fromCharCode(raw.charCodeAt(i) ^ _xorKey(key, i - 1));
        }
        try { return decodeURIComponent(escape(out)); } catch { return out; }
    } catch { return null; }
}

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://tortuga.tw/'
};

// Parse movie VOD page → returns {file: m3u8URL, poster: posterURL}
async function parseTortugaVod(vodUrl, signal) {
    try {
        const proxyConfig = proxyManager.getConfig('tortuga');
        const res = await axios.get(vodUrl, { headers: HEADERS, timeout: 15000, ...proxyConfig, ...(signal ? { signal } : {}) });
        const html = res.data;
        
        // Extract file (m3u8 URL)
        const fileMatch = html.match(/file\s*:\s*["']([A-Za-z0-9+/=]+)["']/);
        if (!fileMatch) return null;
        const file = decodeTortugaFile(fileMatch[1]);
        if (!file) return null;
        
        // Extract poster (optional)
        const posterMatch = html.match(/poster\s*:\s*["']([A-Za-z0-9+/=]+)["']/);
        const poster = posterMatch ? decodeTortugaFile(posterMatch[1]) : null;
        
        return { file, poster };
    } catch (e) {
        console.error('[Tortuga] parseVod error:', e.message);
        return null;
    }
}

// Parse TV series embed page → returns full folder/file JSON
async function parseTortugaEmbed(embedUrl, signal) {
    try {
        const proxyConfig = proxyManager.getConfig('tortuga');
        const res = await axios.get(embedUrl, { headers: HEADERS, timeout: 15000, ...proxyConfig, ...(signal ? { signal } : {}) });
        const html = res.data;
        const fileMatch = html.match(/file\s*:\s*["']([A-Za-z0-9+/=]{20,})["']/);
        if (!fileMatch) return null;

        const decoded = decodeTortugaFile(fileMatch[1]);
        if (!decoded) return null;

        try {
            const json = JSON.parse(decoded);
            if (Array.isArray(json)) {
                // Transform Tortuga format → standard folder/file format
                return json.map(season => ({
                    title: season.title,
                    folder: (season.folder || []).map(ep => ({
                        title: ep.title,
                        folder: (ep.folder || []).map(dub => ({
                            title: dub.title || 'Tortuga',
                            file: dub.file,
                            poster: dub.poster || null,
                            subtitle: dub.subtitle || null,
                        })),
                    })),
                }));
            }
            return null;
        } catch { return null; }
    } catch (e) {
        console.error('[Tortuga] parseEmbed error:', e.message);
        return null;
    }
}

/**
 * Transform raw Tortuga player data (from uaserials.com AES decryption)
 * into standard folder/file format. Decodes VOD URLs to m3u8.
 * @param {Array} players - [{tabName, seasons:[...], episodes:[...], url}]
 * @returns {Promise<Object|null>} {_routes: {tortuga: [...]}}
 */
async function transformTortugaPlayers(players, signal) {
    const routes = {};

    for (const player of players) {
        const tabName = player.tabName || 'Tortuga';
        let transformed;

        if (player.seasons && player.seasons.length > 0) {
            transformed = {
                title: tabName,
                folder: player.seasons.map(season => ({
                    title: season.title,
                    folder: season.episodes.map(episode => ({
                        title: episode.title,
                        folder: (episode.sounds || []).map(sound => ({
                            title: sound.title,
                            file: sound.url,
                        })),
                    })),
                })),
            };
        } else if (player.episodes && player.episodes.length > 0) {
            const hasMultipleSounds = player.episodes.some(ep => ep.sounds && ep.sounds.length > 1);
            if (hasMultipleSounds) {
                transformed = {
                    title: tabName,
                    folder: player.episodes.map(episode => ({
                        title: episode.title,
                        folder: (episode.sounds || []).map(sound => ({
                            title: sound.title || episode.title,
                            file: sound.url,
                        })),
                    })),
                };
            } else {
                transformed = {
                    title: tabName,
                    folder: player.episodes.map(episode => {
                        const sounds = episode.sounds || [episode];
                        return {
                            title: episode.title,
                            file: (sounds[0] && sounds[0].url) || episode.url,
                        };
                    }),
                };
            }
        } else if (player.url) {
            const vodData = await parseTortugaVod(player.url, signal);
            if (!vodData || !vodData.file) continue;
            transformed = { title: tabName, file: vodData.file, poster: vodData.poster };
        } else {
            continue;
        }

        if (!routes.tortuga) routes.tortuga = [];
        routes.tortuga.push(transformed);
    }

    return Object.keys(routes).length ? { _routes: routes } : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
    /**
     * Parse Tortuga iframe URLs (from kinoukr, uaserials.com, etc.)
     * @param {Array<{url: string, label?: string}>} iframes - Array of Tortuga iframe URLs
     * @returns {Array|null} folder/file format data for tortuga provider
     */
    getLinks: async (iframes, signal) => {
        if (!Array.isArray(iframes) || !iframes.length) return null;

        const results = [];

        for (const iframe of iframes) {
            if (/tortuga\.tw\/embed\//i.test(iframe.url)) {
                // TV series embed — decode full JSON structure
                const parsed = await parseTortugaEmbed(iframe.url, signal);
                if (parsed && parsed.length) {
                    results.push(...parsed);
                }
            } else if (/tortuga/i.test(iframe.url)) {
                // Movie VOD — decode single m3u8 URL and poster
                const vodData = await parseTortugaVod(iframe.url, signal);
                if (vodData && vodData.file) {
                    results.push({
                        title: iframe.label || 'Tortuga',
                        file: vodData.file,
                        poster: vodData.poster,
                    });
                }
            }
        }

        if (!results.length) return null;
        return { _routes: { tortuga: results } };
    },

    // Expose helpers for direct use by other providers
    parseTortugaVod,
    parseTortugaEmbed,
    decodeTortugaFile,
    transformTortugaPlayers,
};
