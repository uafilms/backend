const axios = require('axios');
const proxyManager = require('../utils/proxyManager');
const tmdb = require('../tmdb');

const UATUT_BASE = 'https://uk.uatut.fun';
const MY_PROXY = 'ashdi.aartzz.pp.ua';

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': UATUT_BASE + '/',
    'Origin': UATUT_BASE
};

const fix = s => typeof s === 'string' ? s.replace(/0yql3tj/g, "oyql3tj") : s;

// Функція безпечного парсингу JS-об'єктів (якщо JSON.parse не справляється)
function safeParse(str) {
    if (!str) return null;
    try {
        return JSON.parse(str);
    } catch (e) {
        try {
            // Якщо там одинарні лапки або JS-об'єкт -> використовуємо Function
            return new Function('return ' + str)();
        } catch (e2) {
            console.error("[Ashdi] Parse error:", e.message);
            return null;
        }
    }
}

async function getIframe(imdbId, axiosConfig) {
    try {
        const config = {
            ...axiosConfig,
            headers: { ...axiosConfig.headers, ...BASE_HEADERS }
        };

        // 1. Пошук за IMDB ID
        const searchUrl = `${UATUT_BASE}/watch/search.php?q=${encodeURIComponent(imdbId)}`;
        const searchRes = await axios.get(searchUrl, config);

        if (!Array.isArray(searchRes.data) || searchRes.data.length === 0) {
            return null;
        }

        const item = searchRes.data[0];
        if (!item || !item.id) return null;

        // 2. Отримання сторінки
        const pageUrl = `${UATUT_BASE}/watch/${item.id}`;
        const pageRes = await axios.get(pageUrl, config);

        // 3. Пошук iframe
        const match = pageRes.data.match(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/i);
        if (match && match[1]) {
            let src = match[1];
            if (src.startsWith('//')) src = 'https:' + src;

            // === ЗАМІНА ДОМЕНУ НА ТВІЙ ПРОКСІ ===
            if (src.includes('ashdi')) {
                src = src.replace(/ashdi\.[a-z]+/i, MY_PROXY);
            }
            
            return src;
        }
        
        return null;
    } catch (e) {
        console.error(`[Ashdi] Error in getIframe: ${e.message}`);
        return null;
    }
}

function parsePlayer(html, title) {
    // 1. Глобальні параметри
    const posterMatch = html.match(/poster\s*:\s*['"]([^'"]+)['"]/);
    const globalPoster = posterMatch ? fix(posterMatch[1]) : null;

    const subMatch = html.match(/subtitle\s*:\s*['"]([^'"]+)['"]/);
    const globalSubtitle = subMatch ? subMatch[1] : null;

    // 2. Спроба знайти source теги (HTML5)
    const sources = [...html.matchAll(/<source[^>]+src=["']([^"']+\.m3u8[^"']*)["'][^>]*>/gi)]
        .map(m => ({ 
            file: fix(m[1]), 
            quality: m[0].match(/label=["']([^"']+)/i)?.[1] || 'Auto',
            poster: globalPoster,
            subtitle: globalSubtitle
        }));

    if (sources.length) {
        return sources.map(s => ({ 
            file: s.file, title, quality: s.quality, poster: s.poster, subtitle: s.subtitle 
        }));
    }

    // 3. Спроба розпарсити JS конфіг
    // Цей Regex набагато розумніший: він враховує екрановані лапки (\' або \") і не зупиняється на них
    const rawMatch = html.match(/file\s*:\s*(['"])((?:\\\1|.)*?)\1/);
    const raw = rawMatch ? rawMatch[2] : null;
    
    if (!raw) return null;

    // Парсимо (JSON або JS Object)
    const parsedData = safeParse(raw);

    // A. Це СЕРІАЛ (масив)
    if (Array.isArray(parsedData)) {
        const walk = items => items.map(i => {
            const item = {
                title: i.title ? i.title.trim() : undefined,
            };

            if (i.folder) {
                item.folder = walk(i.folder);
            } else {
                item.file = i.file ? fix(i.file) : undefined;
                item.poster = i.poster ? fix(i.poster) : globalPoster;
                item.subtitle = i.subtitle || globalSubtitle; 
            }
            return item;
        });
        
        return walk(parsedData);
    }

    // B. Це ФІЛЬМ (рядок або об'єкт)
    // Якщо parsedData це просто рядок URL
    if (typeof parsedData === 'string') {
        return [{ 
            file: fix(parsedData), 
            title, 
            quality: 'Auto', 
            poster: globalPoster, 
            subtitle: globalSubtitle 
        }];
    }

    return null;
}

module.exports = {
    getLinks: async (imdbId, title) => {
        if (!imdbId) return null;

        const axiosConfig = proxyManager.getConfig('ashdi');
        
        try {
            const iframe = await getIframe(imdbId, axiosConfig);
            if (!iframe) return null;

            // Запит до ashdi через твоє проксі
            const html = (await axios.get(iframe, {
              ...axiosConfig,
              headers: { 'User-Agent': BASE_HEADERS['User-Agent'] }
            })).data;
            
            return parsePlayer(html, title);
        } catch (e) {
            console.error(`[Ashdi] Error in getLinks: ${e.message}`);
            return null;
        }
    },

    getStream: async (id, type, season, episode) => {
        try {
            const info = await tmdb.details(type, id);
            
            let imdbId = info.imdb_id;
            if (!imdbId) {
                const extIds = await tmdb.getExternalIds(id, type === 'tv');
                imdbId = extIds?.imdb_id;
            }

            if (!imdbId) {
                // Тиха відмова, якщо немає ID
                return null;
            }

            const title = info.original_title || info.original_name;
            const links = await module.exports.getLinks(imdbId, title);

            if (!links) return null;

            if (type === 'movie') {
                const src = Array.isArray(links) ? links[0] : links;
                return src?.file ? { url: src.file, type: 'application/x-mpegURL' } : null;
            }

            let found = null;
            const walk = (items, sCtx) => {
                for (const it of items) {
                    let s = sCtx, e = null;
                    const t = it.title || '';
                    const sm = t.match(/(\d+)\s*(?:season|сезон)|(?:season|сезон)\s*(\d+)/i);
                    if (sm) s = parseInt(sm[1] || sm[2]);
                    const em = t.match(/(\d+)\s*(?:episode|серія)|(?:ep|e)\s*(\d+)/i);
                    if (em) e = parseInt(em[1] || em[2]);

                    if (it.folder) walk(it.folder, s);
                    else if (it.file && s == season && e == episode) {
                        found = it.file;
                        return;
                    }
                }
            };

            if (Array.isArray(links)) walk(links, null);
            return found ? { url: found, type: 'application/x-mpegURL' } : null;

        } catch (e) {
            console.error("[Ashdi] getStream error:", e.message);
            return null;
        }
    }
};