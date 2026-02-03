require('dotenv').config();
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const { URL } = require('url'); 
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');

// Імпорти провайдерів
const tmdb = require('./tmdb');
const ashdi = require('./providers/ashdi');
const hdvb = require('./providers/hdvb');
const moonanime = require('./providers/moonanime');
const uaflix = require('./providers/uaflix');

// Англомовні провайдери (CinemaOS видалено)
const uembed = require('./providers/uembed');

const proxyManager = require('./utils/proxyManager');
const { parseMasterPlaylist } = require('./utils/m3u8Parser');
const { searchTorrents } = require('./utils/torrentHandler');
const { parseUaKinoComments } = require('./utils/commentParser');

const app = express();
const cache = new NodeCache({ stdTTL: 300 }); 
const tokenCache = new NodeCache({ stdTTL: 7200, checkperiod: 600 });

app.set('trust proxy', true);

const TURNSTILE_ENABLED = process.env.TURNSTILE_ENABLED === 'true';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
const TOKENS_FILE = path.join(__dirname, 'tokens.json'); 

// Middleware CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range, cf-turnstile-response, x-api-key');
    next();
});

app.options('*', (req, res) => res.sendStatus(200));

// Middleware Turnstile
const checkTurnstile = async (req, res, next) => {
    if (req.method === 'OPTIONS') return next();

    // 0. ПЕРЕВІРКА ЧИ ВЗАГАЛІ УВІМКНЕНО ЗАХИСТ
    // Якщо false — ми не перевіряємо ні капчу, ні API-ключі
    if (!TURNSTILE_ENABLED) {
        return next();
    }

    const userIp = req.ip || req.connection.remoteAddress;

    // 1. BYPASS KEYS (працюють тільки коли Turnstile увімкнено)
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
        try {
            if (fs.existsSync(TOKENS_FILE)) {
                const fileContent = fs.readFileSync(TOKENS_FILE, 'utf8');
                const validTokens = JSON.parse(fileContent);
                if (Array.isArray(validTokens) && validTokens.includes(apiKey)) {
                    return next(); 
                }
            }
        } catch (e) {
            console.error('Error reading tokens file:', e);
        }
    }

    // 2. TURNSTILE TOKEN
    const token = req.headers['cf-turnstile-response'] || req.query.token;
    
    // Якщо токен відсутній, а ми тут (значить Turnstile увімкнено і API-ключ не підійшов)
    if (!token) {
        return res.status(403).json({ error: 'CAPTCHA token missing' });
    }

    // Перевірка кешу (щоб не запитувати Cloudflare двічі для того самого токена)
    const cachedIp = tokenCache.get(token);
    if (cachedIp) {
        if (cachedIp === userIp) {
            return next(); 
        } else {
            console.warn(`Token theft attempt! Token IP: ${cachedIp}, Request IP: ${userIp}`);
            return res.status(403).json({ error: 'Invalid token usage' });
        }
    }

    // Валідація токена через Cloudflare API
    try {
        if (!TURNSTILE_SECRET_KEY) {
            console.error('TURNSTILE_SECRET_KEY is missing in .env');
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const formData = new URLSearchParams();
        formData.append('secret', TURNSTILE_SECRET_KEY);
        formData.append('response', token);
        formData.append('remoteip', userIp);

        const result = await axios.post(
            'https://challenges.cloudflare.com/turnstile/v0/siteverify', 
            formData
        );

        if (result.data.success) {
            tokenCache.set(token, userIp); // Зберігаємо в кеш
            next(); 
        } else {
            return res.status(403).json({ 
                error: 'CAPTCHA validation failed', 
                details: result.data['error-codes'] 
            });
        }
    } catch (err) {
        console.error('Turnstile error:', err.message);
        return res.status(500).json({ error: 'CAPTCHA verification error' });
    }
};


// === STATIC FILES ===
const nodeModules = path.join(__dirname, 'node_modules');
app.use('/static/videojs', express.static(path.join(nodeModules, 'video.js/dist')));
app.use('/static/quality-levels', express.static(path.join(nodeModules, 'videojs-contrib-quality-levels/dist')));
app.use('/static/hotkeys', express.static(path.join(nodeModules, 'videojs-hotkeys')));
app.use('/static/playlist', express.static(path.join(nodeModules, 'videojs-playlist/dist')));
app.use('/static/mobile-ui', express.static(path.join(nodeModules, 'videojs-mobile-ui/dist')));
app.use('/static/custom', express.static(__dirname));
app.use(express.static('public'));

// --- HELPER FUNCTIONS ---
const fetchWithManualRedirect = async (url, config = {}, retries = 5) => {
    try {
        const response = await axios.get(url, { ...config, responseType: 'stream', validateStatus: status => status < 400, maxRedirects: 0 });
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
            if (retries === 0) throw new Error('Too many redirects');
            const redirectUrl = new URL(response.headers.location, url).href;
            return fetchWithManualRedirect(redirectUrl, config, retries - 1);
        }
        return response;
    } catch (e) {
        if (e.response && e.response.status >= 300 && e.response.status < 400 && e.response.headers.location) {
            if (retries === 0) throw new Error('Too many redirects');
            const redirectUrl = new URL(e.response.headers.location, url).href;
            return fetchWithManualRedirect(redirectUrl, config, retries - 1);
        }
        throw e;
    }
};

function parseSubtitles(subInput) {
    if (!subInput) return [];
    if (Array.isArray(subInput)) return subInput;
    if (typeof subInput !== 'string') return [];

    const subs = [];
    const regex = /(?:\[(.*?)\])?(https?:\/\/[^,]+)/g;
    let match;
    while ((match = regex.exec(subInput)) !== null) {
        subs.push({ 
            label: match[1] || 'Default', 
            lang: (match[1] && match[1].toLowerCase().includes('en')) ? 'en' : 'ua', 
            url: match[2] 
        });
    }
    return subs;
}

function injectSubtitles(m3u8Text, subtitles, host, referer, token) {
    if (!subtitles || !Array.isArray(subtitles) || subtitles.length === 0) return m3u8Text;
    if (!m3u8Text.includes('#EXT-X-STREAM-INF')) return m3u8Text; 
    const lines = m3u8Text.split('\n');
    const newLines = [];
    const groupId = 'subs';
    let mediaAdded = false;
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    const mediaTags = subtitles.map((sub, i) => {
        const isDefault = i === 0 ? 'YES' : 'NO';
        const subProxyUrl = `${host}/api/uaflix/proxy/subtitle.vtt?url=${encodeURIComponent(sub.url)}&referer=${encodeURIComponent(referer)}${tokenParam}`;
        return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${groupId}",NAME="${sub.label}",DEFAULT=${isDefault},AUTOSELECT=YES,LANGUAGE="${sub.lang}",URI="${subProxyUrl}"`;
    });
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
            if (!mediaAdded) { newLines.push(...mediaTags); mediaAdded = true; }
            newLines.push(`${trimmed},SUBTITLES="${groupId}"`);
        } else { newLines.push(line); }
    }
    return newLines.join('\n');
}

async function extractUaflixM3u8(pageUrl, playerIndex = 0) {
    try {
        const proxyConfig = proxyManager.getConfig('uaflix');
        const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://uafix.net/' };
        const { data: pageHtml } = await axios.get(pageUrl, { headers, ...proxyConfig });
        const $ = cheerio.load(pageHtml);
        let iframeSrc;
        const videoBoxes = $('.tabs-b.video-box');
        if (videoBoxes.length > 0) {
            const targetBox = videoBoxes.eq(playerIndex < videoBoxes.length ? playerIndex : 0);
            iframeSrc = targetBox.find('iframe').attr('src');
        } else { iframeSrc = $('.video-box iframe').attr('src'); }
        if (!iframeSrc) return null;
        if (iframeSrc.startsWith('//')) iframeSrc = 'https:' + iframeSrc;
        else if (iframeSrc.startsWith('/')) iframeSrc = 'https://uafix.net' + iframeSrc;
        const { data: iframeHtml } = await axios.get(iframeSrc, { headers: { ...headers, 'Referer': pageUrl }, ...proxyConfig });
        let m3u8Link = null;
        const fileMatch = iframeHtml.match(/file:\s?["']([^"']+\.m3u8)["']/);
        if (fileMatch) m3u8Link = fileMatch[1];
        else { const rawMatch = iframeHtml.match(/https?:\/\/[^\s"']+\.m3u8/); if (rawMatch) m3u8Link = rawMatch[0]; }
        let subtitles = [];
        const subMatch = iframeHtml.match(/(?:subtitle|subtitles):\s?["']([^"']+)["']/i);
        if (subMatch) { subtitles = parseSubtitles(subMatch[1]); }
        if (!m3u8Link) return null;
        return { m3u8Link, subtitles, referer: iframeSrc };
    } catch (e) { console.error("Extract Uaflix Error:", e.message); return null; }
}

function normalizeResponse(tmdbData, type, token = '') {
    const seasonsMap = new Map();
    const movieSources = [];
    
    const traverse = (providerName, items, context) => {
        if (!Array.isArray(items)) return;
        items.forEach(item => {
            let currentContext = { ...context };
            let rawTitle = item.title || "";
            let sMatch = rawTitle.match(/(?:season|сезон|s)\s*(\d+)/i);
            if (!sMatch) sMatch = rawTitle.match(/(\d+)\s*(?:season|сезон)/i);
            if (sMatch) currentContext.season = parseInt(sMatch[1]);
            let eMatch = rawTitle.match(/(?:episode|серія|ep|e)\s*(\d+)/i);
            if (!eMatch) eMatch = rawTitle.match(/(\d+)\s*(?:episode|серія)/i);
            if (eMatch) currentContext.episode = parseInt(eMatch[1]);
            if (item.folder) {
                let cleanName = rawTitle;
                if (sMatch) cleanName = cleanName.replace(sMatch[0], '');
                if (eMatch) cleanName = cleanName.replace(eMatch[0], '');
                cleanName = cleanName.replace(/[\(\)\[\]]/g, '').trim();
                cleanName = cleanName.replace(/^[\s\-\.]+|[\s\-\.]+$/g, '');
                if (cleanName.length > 0 && !/^\d+$/.test(cleanName)) { currentContext.dub = cleanName; }
                traverse(providerName, item.folder, currentContext);
            } 
            else if (item.file || item.link || item.url) { 
                let s = currentContext.season || item.season || 1;
                let e = currentContext.episode || item.episode;
                let dubName = currentContext.dub || item.name || "Original";
                let sourceSubtitles = [];
                
                if (item.subtitle || item.subtitles) { 
                    sourceSubtitles = parseSubtitles(item.subtitle || item.subtitles); 
                }
                
                const createSourceObj = (url, quality = null) => {
                    let mimeType = 'video/mp4';
                    if (url.includes('.m3u8') || providerName === 'ashdi' || providerName === 'uaflix' || providerName === 'uembed') { mimeType = 'application/x-mpegURL'; } 
                    else if (url.includes('.webm')) { mimeType = 'video/webm'; }
                    
                    let finalUrl = url;
                    if (token && (finalUrl.includes('/api/uaflix') || finalUrl.includes('/api/moonanime') || finalUrl.includes('/proxy/m3u8'))) {
                        const separator = finalUrl.includes('?') ? '&' : '?';
                        if (!finalUrl.includes('token=')) {
                            finalUrl += `${separator}token=${encodeURIComponent(token)}`;
                        }
                    }
                    return { 
                        provider: providerName, 
                        dub: dubName, 
                        quality: quality || item.quality || 'Auto', 
                        url: finalUrl, 
                        type: mimeType, 
                        subtitles: sourceSubtitles, 
                        poster: item.poster || null,
                        headers: item.headers 
                    };
                };
                const url = item.file || item.link || item.url;
                if (providerName === 'moonanime' && url.includes('[')) {
                    const parts = url.split(',');
                    parts.forEach(part => {
                        const m = part.match(/\[(.*?)\](.*)/);
                        if (m) {
                            const srcObj = createSourceObj(m[2], m[1]);
                            if (type === 'movie') movieSources.push(srcObj);
                            else addToSeriesMap(s, e, srcObj, item.poster || tmdbData.poster_path);
                        }
                    });
                } else {
                    const srcObj = createSourceObj(url);
                    if (type === 'movie') movieSources.push(srcObj);
                    else {
                        if (!e) { const fileTitleMatch = rawTitle.match(/(?:episode|серія|ep|e)\s*(\d+)/i) || rawTitle.match(/(\d+)\s*(?:episode|серія)/i); if (fileTitleMatch) e = parseInt(fileTitleMatch[1]); else e = items.indexOf(item) + 1; }
                        addToSeriesMap(s, e, srcObj, item.poster || tmdbData.poster_path);
                    }
                }
            }
        });
    };

    const addToSeriesMap = (s, e, sourceObj, poster) => {
        if (!seasonsMap.has(s)) seasonsMap.set(s, new Map());
        const episodesMap = seasonsMap.get(s);
        if (!episodesMap.has(e)) { episodesMap.set(e, { season: s, episode: e, title: `Episode ${e}`, poster: poster, sources: [] }); }
        episodesMap.get(e).sources.push(sourceObj);
    };

        if (tmdbData.links) {
        Object.keys(tmdbData.links).forEach(provider => {
            const providerData = tmdbData.links[provider];
            if (providerData) {
                const items = Array.isArray(providerData) ? providerData : [providerData];
                traverse(provider, items, { season: null, episode: null, dub: null });
            }
        });
    }

    const response = { 
        id: tmdbData.id, 
        imdb_id: tmdbData.imdb_id, 
        type: tmdbData.type, 
        title: tmdbData.title, 
        original_title: tmdbData.original_title, 
        year: tmdbData.year, 
        poster_path: tmdbData.poster_path, 
        backdrop_path: tmdbData.backdrop_path, 
        overview: tmdbData.overview, 
        genres: tmdbData.genres, 
        imdb_rating: tmdbData.imdb_rating 
    };
    if (type === 'movie') { response.sources = movieSources; } 
    else { response.seasons = Array.from(seasonsMap.keys()).sort((a, b) => a - b).map(sNum => { const epMap = seasonsMap.get(sNum); return { number: sNum, episodes: Array.from(epMap.values()).sort((a, b) => a.episode - b.episode) }; }); }
    return response;
}

async function getMetadata(id, type) {
    const info = await tmdb.details(type, id);
    const extIds = await tmdb.getExternalIds(id, type === 'tv');
    const orgTitle = info.original_title || info.original_name;
    const uaTitle = info.title || info.name;
    const year = (info.release_date || info.first_air_date || "").split("-")[0];
    let imdbRating = null;
    if (extIds?.imdb_id) { try { const r = await axios.get(`https://api.imdbapi.dev/titles/${extIds.imdb_id}`, {timeout: 2000}); imdbRating = r.data?.rating?.aggregateRating; } catch(e){} }
    
    return {
        id, type, title: uaTitle, original_title: orgTitle, 
        imdb_id: extIds?.imdb_id, kinopoisk_id: extIds?.kinopoisk_id,
        imdb_rating: imdbRating, year, genres: info.genres, 
        overview: info.overview, backdrop_path: info.backdrop_path, 
        poster_path: info.poster_path
    };
}

// Визначення груп провайдерів
const uaProvidersList = {
    ashdi: (m) => ashdi.getLinks(m.imdb_id, m.imdb_id ? m.original_title : m.title),
    hdvb: (m) => hdvb.getLinks(m.title, m.year),
    moonanime: (m, h) => moonanime.getLinks(m.imdb_id, m.title, m.year, h),
    uaflix: (m, h) => uaflix.getLinks(m.imdb_id, m.title, m.original_title, m.year, m.type, h)
};

const engProvidersList = {
    uembed: (m) => uembed.getLinks(m)
};

async function getLinks(metadata, host, activeProviders) {
    const results = {};
    const promises = Object.entries(activeProviders).map(async ([name, func]) => {
        try {
            results[name] = await func(metadata, host);
        } catch (e) {
            console.error(`Provider ${name} failed:`, e.message);
            results[name] = [];
        }
    });
    await Promise.all(promises);
    return results;
}

// === API ROUTES ===

app.get('/api/details', async (req, res) => {
    const { id, type } = req.query;
    if (!id || !type) return res.status(400).json({ error: "Missing params" });
    const cacheKey = `meta_v3_${type}_${id}`;
    let metaData = cache.get(cacheKey);
    try {
        if (!metaData) {
            metaData = await getMetadata(id, type);
            cache.set(cacheKey, metaData, 3600); 
        }
        const data = normalizeResponse(metaData, type, '');
        res.json(data);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get('/api/get', checkTurnstile, async (req, res) => {
    const { id, type, sse, eng = 0 } = req.query; 
    const token = req.headers['cf-turnstile-response'] || req.query.token; 
    if (!id || !type) return res.status(400).json({ error: "Missing params" });
    
    // Вибираємо список провайдерів
    let activeProviders = {};
    const engMode = parseInt(eng);

    if (engMode === 1) {
        // UA + ENG
        activeProviders = { ...uaProvidersList, ...engProvidersList };
    } else if (engMode === 2) {
        // Only ENG
        activeProviders = engProvidersList;
    } else {
        // Only UA (Default)
        activeProviders = uaProvidersList;
    }

    const metaCacheKey = `meta_v3_${type}_${id}`;
    const fullCacheKey = `full_data_v3_${type}_${id}_eng${engMode}`;
    
    const updateCacheIncrementally = (newDataLinks) => {
        let currentFullData = cache.get(fullCacheKey);
        if (!currentFullData) {
             const meta = cache.get(metaCacheKey);
             if (meta) {
                 currentFullData = { ...meta, links: {} };
             } else {
                 return; 
             }
        }
        currentFullData.links = { ...currentFullData.links, ...newDataLinks };
        cache.set(fullCacheKey, currentFullData, 300);
    };

    if (sse === '1') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        try {
            let fullData = cache.get(fullCacheKey);
            if (fullData) {
                const initialData = normalizeResponse(fullData, type, token);
                const cleanMeta = { ...initialData };
                delete cleanMeta.sources;
                delete cleanMeta.seasons;
                res.write(`data: ${JSON.stringify(cleanMeta)}\n\n`);
                
                if (fullData.links) {
                    Object.entries(fullData.links).forEach(([providerName, links]) => {
                         if (links && (Array.isArray(links) ? links.length > 0 : Object.keys(links).length > 0)) {
                            if (activeProviders[providerName]) {
                                const chunkMeta = { ...fullData, links: { [providerName]: links } };
                                const normalizedChunk = normalizeResponse(chunkMeta, type, token);
                                const payload = { provider: providerName, sources: normalizedChunk.sources, seasons: normalizedChunk.seasons };
                                res.write(`data: ${JSON.stringify(payload)}\n\n`);
                            }
                         }
                    });
                }
                res.write('event: complete\ndata: "done"\n\n');
                return res.end();
            }

            let metaData = cache.get(metaCacheKey);
            if (!metaData) {
                metaData = await getMetadata(id, type);
                cache.set(metaCacheKey, metaData, 3600);
            }
            
            cache.set(fullCacheKey, { ...metaData, links: {} }, 300);

            const initialData = normalizeResponse(metaData, type, token);
            res.write(`data: ${JSON.stringify(initialData)}\n\n`);
            
            const host = `${req.protocol}://${req.get('host')}`;
            
            const promises = Object.entries(activeProviders).map(async ([name, func]) => {
                try {
                    const links = await func(metaData, host);
                    if (links && (Array.isArray(links) ? links.length > 0 : Object.keys(links).length > 0)) {
                        updateCacheIncrementally({ [name]: links });
                        const chunkMeta = { ...metaData, links: { [name]: links } };
                        const normalizedChunk = normalizeResponse(chunkMeta, type, token);
                        const payload = { provider: name, sources: normalizedChunk.sources, seasons: normalizedChunk.seasons };
                        res.write(`data: ${JSON.stringify(payload)}\n\n`);
                    }
                } catch (e) {}
            });
            
            await Promise.all(promises);
            res.write('event: complete\ndata: "done"\n\n');
            return res.end();
        } catch (e) {
            console.error("SSE Error:", e);
            res.write('event: error\ndata: "Internal Error"\n\n');
            return res.end();
        }
    }
    
    let fullData = cache.get(fullCacheKey);
    try {
        if (!fullData) {
            const metaCacheKey = `meta_v3_${type}_${id}`;
            let metaData = cache.get(metaCacheKey);
            if (!metaData) {
                metaData = await getMetadata(id, type);
                cache.set(metaCacheKey, metaData, 3600);
            }
            const host = `${req.protocol}://${req.get('host')}`;
            const links = await getLinks(metaData, host, activeProviders);
            fullData = { ...metaData, links };
            cache.set(fullCacheKey, fullData, 300);
        }
        const data = normalizeResponse(fullData, type, token);
        res.json(data);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get('/embed', checkTurnstile, async (req, res) => {
    const { id, type, source, eng = 0 } = req.query;
    const turnstileToken = req.query.token || '';
    if (!id || !type) return res.status(400).send("Missing parameters");
    
    let activeProviders = {};
    const engMode = parseInt(eng);

    if (engMode === 1) {
        activeProviders = { ...uaProvidersList, ...engProvidersList };
    } else if (engMode === 2) {
        activeProviders = engProvidersList;
    } else {
        activeProviders = uaProvidersList;
    }

    const fullCacheKey = `full_data_v3_${type}_${id}_eng${engMode}`;
    let fullData = cache.get(fullCacheKey);
    
    if (!fullData) {
        const metaCacheKey = `meta_v3_${type}_${id}`;
        let metaData = cache.get(metaCacheKey);
        if (!metaData) {
            metaData = await getMetadata(id, type);
            cache.set(metaCacheKey, metaData, 3600);
        }
        const host = `${req.protocol}://${req.get('host')}`;
        const links = await getLinks(metaData, host, activeProviders);
        fullData = { ...metaData, links };
        cache.set(fullCacheKey, fullData, 300);
    }
    
    const data = normalizeResponse(fullData, type, turnstileToken);
    
    const playlist = [];
    if (type === 'movie') {
        let sources = data.sources || [];
        if (source) { 
            const filtered = sources.filter(src => src.provider === source); 
            if (filtered.length > 0) sources = filtered; 
        }
        
        if (sources.length > 0) {
            const bestSource = sources[0];
            let posterUrl = bestSource.poster;
            if (!posterUrl && data.poster_path) posterUrl = `https://image.tmdb.org/t/p/w1280${data.poster_path}`;
            playlist.push({ 
                name: data.title, 
                poster: posterUrl || '', 
                sources: [{ src: bestSource.url, type: bestSource.type, subtitles: bestSource.subtitles }], 
                meta: { season: 0, episode: 0, allSources: sources } 
            });
        }
    } else {
        if (data.seasons) {
            data.seasons.forEach(s => {
                s.episodes.forEach(e => {
                    let epSources = e.sources;
                    if (source) { 
                        const filtered = epSources.filter(src => src.provider === source); 
                        if (filtered.length > 0) epSources = filtered; 
                    }
                    
                    if (epSources.length > 0) {
                        const bestSource = epSources[0];
                        let posterUrl = bestSource.poster || e.poster;
                        if (!posterUrl && data.poster_path) posterUrl = `https://image.tmdb.org/t/p/w1280${data.poster_path}`;
                        else if (posterUrl && posterUrl.startsWith('/')) posterUrl = `https://image.tmdb.org/t/p/w1280${posterUrl}`;
                        
                        playlist.push({ 
                            name: `S${s.number} E${e.episode}`, 
                            sources: [{ src: bestSource.url, type: bestSource.type, subtitles: bestSource.subtitles }], 
                            poster: posterUrl || '', 
                            meta: { season: s.number, episode: e.episode, allSources: epSources } 
                        });
                    }
                });
            });
        }
    }
    
    if (playlist.length === 0) return res.status(404).send('No content found for selected source');
    // HTML шаблон...
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${data.title}</title><link href="/static/videojs/video-js.css" rel="stylesheet" /><link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet"><link href="/static/mobile-ui/videojs-mobile-ui.css" rel="stylesheet" /><link href="/player-style.css" rel="stylesheet" /></head><body><div class="player-wrapper"><video id="my-video" class="video-js" controls preload="metadata" crossorigin="anonymous"><p class="vjs-no-js">Enable JS</p></video><div id="player-header"><div class="header-controls"><select id="season-select" class="ep-select" style="display:none"></select><select id="episode-select" class="ep-select" style="display:none"></select></div></div><div id="settings-menu" class="settings-menu"><div id="main-menu"><div class="settings-item" onclick="openSubmenu('quality')"><div class="settings-label"><span class="material-icons">hd</span> Якість</div><div class="settings-value" id="val-quality">Auto</div></div><div class="settings-item" onclick="openSubmenu('audio')"><div class="settings-label"><span class="material-icons">mic</span> Озвучка</div><div class="settings-value" id="val-audio">Default</div></div><div class="settings-item" onclick="openSubmenu('speed')"><div class="settings-label"><span class="material-icons">speed</span> Швидкість</div><div class="settings-value" id="val-speed">Звичайна</div></div><div class="settings-item" onclick="openSubmenu('subs')"><div class="settings-label"><span class="material-icons">subtitles</span> Субтитри</div><div class="settings-value" id="val-subs">Вимк</div></div></div><div id="submenu-quality" class="settings-submenu"><div class="submenu-header" onclick="closeSubmenu()"><span class="material-icons">arrow_back</span> Якість</div><div class="submenu-scroll" id="quality-options"></div></div><div id="submenu-audio" class="settings-submenu"><div class="submenu-header" onclick="closeSubmenu()"><span class="material-icons">arrow_back</span> Озвучка</div><div class="submenu-scroll" id="audio-options"></div></div><div id="submenu-speed" class="settings-submenu"><div class="submenu-header" onclick="closeSubmenu()"><span class="material-icons">arrow_back</span> Швидкість</div><div class="submenu-option selected" onclick="setSpeed(1)" data-speed="1">Звичайна</div><div class="submenu-option" onclick="setSpeed(1.25)" data-speed="1.25">1.25x</div><div class="submenu-option" onclick="setSpeed(1.5)" data-speed="1.5">1.5x</div><div class="submenu-option" onclick="setSpeed(2)" data-speed="2">2x</div></div><div id="submenu-subs" class="settings-submenu"><div class="submenu-header" onclick="closeSubmenu()"><span class="material-icons">arrow_back</span> Субтитри</div><div class="submenu-scroll" id="subs-options"></div></div></div></div><script src="/static/videojs/video.min.js"></script><script src="/static/quality-levels/videojs-contrib-quality-levels.min.js"></script><script src="/static/hotkeys/videojs.hotkeys.min.js"></script><script src="/static/playlist/videojs-playlist.min.js"></script><script src="/static/mobile-ui/videojs-mobile-ui.min.js"></script>
    <script>
        const cfToken = "${turnstileToken}";
        const myOrigin = window.location.origin;
        function shouldAddToken(url) {
            if (!url) return false;
            if (url.startsWith('/')) return true; 
            if (url.startsWith(myOrigin)) return true;
            return false; 
        }
        if (cfToken && videojs.Vhs) {
            videojs.Vhs.xhr.beforeRequest = function(options) {
                if (shouldAddToken(options.uri)) {
                    options.headers = options.headers || {};
                    options.headers['cf-turnstile-response'] = cfToken;
                }
                return options;
            };
        }
        if (cfToken && videojs.Hls) {
            videojs.Hls.xhr.beforeRequest = function(options) {
                if (shouldAddToken(options.uri)) {
                    options.headers = options.headers || {};
                    options.headers['cf-turnstile-response'] = cfToken;
                }
                return options;
            };
        }
        var rawPlaylist = ${JSON.stringify(playlist)};
        if (Array.isArray(rawPlaylist)) {
            rawPlaylist.forEach(item => {
                if (item.sources) {
                    item.sources.forEach(src => {
                        const s = src.src;
                        if (s.includes('.m3u8') || s.includes('/moonanime/stream/') || s.includes('/proxy/m3u8')) {
                            src.type = 'application/x-mpegURL';
                        } else if (s.endsWith('.webm')) {
                            src.type = 'video/webm';
                        } else {
                            src.type = 'video/mp4';
                        }
                    });
                }
            });
        }
        window.rawPlaylist = rawPlaylist;
    </script>
    <script src="/player-script.js"></script></body></html>`);
});

// Решта роутів без змін...
// (uaflix, moonanime, proxy, home, search, torrents, comments, etc)
app.get('/api/uaflix/stream/master.m3u8', checkTurnstile, async (req, res) => {
    // ...
    // (весь попередній код залишається таким самим)
    const pageUrl = req.query.url;
    const playerIndex = parseInt(req.query.player) || 0;
    const token = req.query.token || req.headers['cf-turnstile-response'];
    if (!pageUrl) return res.status(400).send('Missing url');
    const cacheKey = `uaflix_stream_v19_p${playerIndex}_${Buffer.from(pageUrl).toString('base64')}`;
    let streamData = cache.get(cacheKey);
    try {
        if (!streamData) {
            const extracted = await extractUaflixM3u8(pageUrl, playerIndex);
            if (extracted) { streamData = extracted; cache.set(cacheKey, streamData, 300); } 
            else return res.status(404).send('Player not found');
        }
        const host = `${req.protocol}://${req.get('host')}`;
        res.set('Content-Type', 'application/vnd.apple.mpegurl'); 
        const proxyConfig = proxyManager.getConfig('uaflix');
        const response = await fetchWithManualRedirect(streamData.m3u8Link, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': streamData.referer, 'Accept': '*/*' }, ...proxyConfig });
        const chunks = [];
        for await (const chunk of response.data) chunks.push(chunk);
        let m3u8Text = Buffer.concat(chunks).toString('utf-8');
        const finalUrl = response.request?.res?.responseUrl || response.config.url;
        const baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
        if (streamData.subtitles && streamData.subtitles.length > 0) {
            m3u8Text = injectSubtitles(m3u8Text, streamData.subtitles, host, streamData.referer, token);
        }
        const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
        const newM3u8Text = m3u8Text.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            let absoluteUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
            if (absoluteUrl.includes('.m3u8')) {
                return `${host}/api/uaflix/proxy/index.m3u8?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(streamData.referer)}${tokenParam}`;
            }
            return absoluteUrl;
        }).join('\n');
        res.send(newM3u8Text);
    } catch (e) { cache.del(cacheKey); res.status(e.response ? e.response.status : 503).send(e.message); }
});

app.get('/api/uaflix/proxy/:filename?', checkTurnstile, async (req, res) => {
    // ... (без змін)
    const targetUrl = req.query.url;
    const refererUrl = req.query.referer || 'https://uafix.net/'; 
    const subtitlesParam = req.query.subtitles;
    const token = req.query.token || req.headers['cf-turnstile-response'];
    if (!targetUrl) return res.status(400).send('Missing url');
    try {
        const proxyConfig = proxyManager.getConfig('uaflix');
        const response = await fetchWithManualRedirect(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': refererUrl, 'Accept': '*/*' }, ...proxyConfig });
        if (targetUrl.includes('.m3u8') || (req.params.filename && req.params.filename.endsWith('.m3u8'))) {
            const chunks = [];
            for await (const chunk of response.data) chunks.push(chunk);
            let m3u8Text = Buffer.concat(chunks).toString('utf-8');
            const host = `${req.protocol}://${req.get('host')}`;
            const finalUrl = response.request?.res?.responseUrl || response.config.url;
            const baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
            if (subtitlesParam) {
                try { const subtitles = JSON.parse(subtitlesParam); m3u8Text = injectSubtitles(m3u8Text, subtitles, host, refererUrl, token); } catch (e) {}
            }
            const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
            const newM3u8Text = m3u8Text.split('\n').map(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;
                let absoluteUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
                if (absoluteUrl.includes('.m3u8')) {
                    return `${host}/api/uaflix/proxy/index.m3u8?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(refererUrl)}${tokenParam}`;
                }
                return absoluteUrl;
            }).join('\n');
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(newM3u8Text);
        }
        const contentType = response.headers['content-type'];
        if (contentType) res.set('Content-Type', contentType);
        response.data.pipe(res);
    } catch (e) { if (!res.headersSent) res.status(e.response ? e.response.status : 500).send("Proxy error"); }
});

app.get('/api/moonanime/stream/:vodId', checkTurnstile, async (req, res) => {
    // ... (без змін)
    try {
        const url = `https://moonanime.art/vod/${req.params.vodId}/?partner=lampa`;
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://moonanime.art/', 'origin': 'http://lampa.mx' } });
        let file = (response.data.match(/file:\s?["']([^"']+)["']/) || [])[1];
        if (file) {
            let targetUrl = file;
            if (file.includes('[') && file.includes(']')) {
                const links = {};
                file.split(',').forEach(part => { const match = part.match(/\[(.*?)\](.*)/); if (match) links[match[1]] = match[2]; });
                const qualityPriority = ['1080p', '720p', '480p', '360p'];
                let found = false;
                for (const q of qualityPriority) { if (links[q]) { targetUrl = links[q]; found = true; break; } }
                if (!found) { const available = Object.keys(links); if (available.length > 0) targetUrl = links[available[0]]; }
            }
            if (targetUrl.includes('.m3u8')) {
                try {
                    const m3u8Res = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://moonanime.art/' } });
                    const protocol = req.protocol;
                    const host = req.get('host');
                    const proxyHost = `${protocol}://${host}`;
                    const modifiedM3u8 = parseMasterPlaylist(m3u8Res.data, targetUrl, proxyHost);
                    res.set('Content-Type', 'application/vnd.apple.mpegurl');
                    return res.send(modifiedM3u8);
                } catch (e) { console.error("MoonAnime Proxy Error:", e.message); return res.redirect(targetUrl); }
            }
            return res.redirect(targetUrl);
        }
        res.status(404).send('Stream not found');
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/proxy/m3u8', checkTurnstile, async (req, res) => {
    // ... (без змін)
    try {
        const { url } = req.query;
        if (!url) return res.status(400).send('URL required');
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': '*/*', };
        const response = await axios.get(url, { headers });
        const protocol = req.protocol;
        const host = req.get('host');
        const proxyHost = `${protocol}://${host}`;
        const modifiedM3u8 = parseMasterPlaylist(response.data, url, proxyHost);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(modifiedM3u8);
    } catch (e) { console.error("Proxy M3U8 Error:", e.message); res.status(500).send('#EXTM3U\n#EXT-X-ERROR: ' + e.message); }
});

app.get('/api/home', async (req, res) => {
    // ... (без змін)
    const includeAdult = req.query.adult === 'true';
    const cacheKey = `homepage_data_${includeAdult}`;
    const cachedData = cache.get(cacheKey);
    if (cachedData) return res.json(cachedData);
    try {
        const [trending, recommended, ukrainian, cartoons, anime] = await Promise.all([
            tmdb.getTrending('week', 'all'), tmdb.getRecommended('movie', includeAdult), tmdb.getUkrainian('movie', includeAdult), tmdb.getCartoons('movie', includeAdult), tmdb.getAnime('movie', includeAdult)
        ]);
        const responseData = { trending: trending.results, recommended: recommended.results, ukrainian: ukrainian.results, cartoons: cartoons.results, anime: anime.results };
        cache.set(cacheKey, responseData, 300);
        res.json(responseData);
    } catch (e) { res.status(500).json({ error: "Failed" }); }
});

app.get('/api/search', async (req, res) => {
    // ... (без змін)
    const { q, page = 1, adult = 'false' } = req.query; 
    if (!q) return res.json({ results: [], total_pages: 0 });
    try { const data = await tmdb.search(q, page, adult === 'true'); res.json(data); } catch (e) { res.status(500).json({ error: "Search failed" }); }
});

app.get('/api/torrents', checkTurnstile, async (req, res) => {
    // ... (без змін)
    try {
        const { tmdbId, type } = req.query;
        const results = await searchTorrents({ tmdbId, type });
        res.json(results);
    } catch (error) { console.error(error); res.status(500).json({ error: 'Internal Server Error' }); }
});

app.get('/api/comments', async (req, res) => {
    // ... (без змін)
    const { imdb_id, page = 1 } = req.query;
    if (!imdb_id) return res.status(400).json({ error: 'IMDB ID is required' });
    try {
        const searchUrl = `https://uakino.best/engine/lazydev/dle_search/ajax.php`;
        const searchParams = new URLSearchParams();
        searchParams.append('story', imdb_id);
        const searchRes = await axios.post(searchUrl, searchParams, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
        const searchHtml = searchRes.data.content;
        const linkMatch = searchHtml.match(/href=["'](https:\/\/uakino\.best\/(\d+)-[^"']+\.html)["']/);
        if (!linkMatch || !linkMatch[2]) { console.log('Movie not found on UaKino via search'); return res.json([]); }
        const newsId = linkMatch[2]; 
        const commentsUrl = `https://uakino.best/engine/ajax/controller.php?mod=comments&cstart=${page}&news_id=${newsId}&skin=uakino&massact=disable`;
        const commentsRes = await axios.get(commentsUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36', 'X-Requested-With': 'XMLHttpRequest' } });
        const jsonResponse = commentsRes.data;
        if (jsonResponse && jsonResponse.comments) { const parsedComments = parseUaKinoComments(jsonResponse.comments); res.json(parsedComments); } else { res.json([]); }
    } catch (error) { console.error('Error fetching comments:', error.message); res.status(500).json({ error: 'Failed to fetch comments' }); }
});

app.get('/', (req, res) => {
    res.redirect('https://uafilms.mintlify.app/');
});

module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running locally on port ${PORT}`);
    });
}