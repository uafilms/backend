const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');

const BASE_URL = 'https://uafix.net';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Referer': BASE_URL
};

const { getLinksFromAshdiUrl } = require('./ashdi');

const normalizeTitle = (str) => {
    if (!str) return '';
    return str.toLowerCase()
        .replace(/['`ʼ’]/g, "'")
        .replace(/ё/g, "е")
        .replace(/[^a-z0-9а-яіїєґ'\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
};

module.exports = {
    getLinks: async (imdb_id, title, origTitle, year, type, host) => {
        const axiosConfig = proxyManager.getConfig('uaflix') || {};
        
        try {
            console.log(`[UAFlix] Searching for: ${title} (${year})`);
            let candidates = await searchUaflix(title, year, axiosConfig);

            if ((!candidates || candidates.length === 0) && origTitle) {
                console.log(`[UAFlix] UA search failed, trying EN: ${origTitle}`);
                const candidatesEn = await searchUaflix(origTitle, year, axiosConfig);
                if (candidatesEn && candidatesEn.length > 0) candidates = candidatesEn;
            }

            if (!candidates || candidates.length === 0) {
                console.log('[UAFlix] No candidates found');
                return null;
            }

            const targetUa = normalizeTitle(title);
            const targetEn = normalizeTitle(origTitle);

            let bestMatch = candidates.find(c => {
                if (c.year && year && Math.abs(parseInt(c.year) - parseInt(year)) > 1) return false;
                const siteTitles = c.rawTitle.split('/').map(t => normalizeTitle(t));
                return siteTitles.some(t => t === targetUa || (targetEn && t === targetEn));
            });

            if (!bestMatch) {
                bestMatch = candidates.find(c => {
                    if (c.year && year && Math.abs(parseInt(c.year) - parseInt(year)) > 1) return false;
                    const normalizedSiteTitle = normalizeTitle(c.rawTitle);
                    return normalizedSiteTitle.includes(targetUa) || (targetEn && normalizedSiteTitle.includes(targetEn));
                });
            }

            if (!bestMatch) return null;

            const contentUrl = bestMatch.link;
            console.log(`[UAFlix] Match found: ${contentUrl}`);

            let posterUrl = bestMatch.img;
            let fullPosterUrl = posterUrl && !posterUrl.startsWith('http') ? BASE_URL + posterUrl : posterUrl;

            // --- ФІЛЬМИ (Movie) ---
            if (type === 'movie') {
                console.log('[UAFlix] Processing Movie...');
                const moviePageRes = await axios.get(contentUrl, { headers: HEADERS, ...axiosConfig });
                const $m = cheerio.load(moviePageRes.data);

                const ogImage = $m('meta[property="og:image"]').attr('content');
                if (ogImage) fullPosterUrl = ogImage;

                const players = [];
                const tabs = $m('.tabs-sel .tabs-link');
                const contents = $m('.tabs-b.video-box');

                if (tabs.length > 0 && contents.length > 0) {
                    tabs.each((i, tab) => {
                        const tabName = $m(tab).text().trim(); 
                        const contentDiv = contents.eq(i);
                        const iframeSrc = contentDiv.find('iframe').attr('src');
                        if (iframeSrc) players.push({ name: tabName, src: iframeSrc, index: i });
                    });
                } else {
                    const iframeSrc = $m('.video-box iframe').attr('src');
                    if (iframeSrc) players.push({ name: "Дивитись онлайн", src: iframeSrc, index: 0 });
                }

                if (players.length === 0) return null;

                const ashdiResults = [];
                const uaflixResults = [];
                for (const player of players) {
                    try {
                        const isAshdi = player.src.includes('ashdi.vip') || player.name.toLowerCase().includes('ashdi');
                        const providerName = player.name;

                        if (isAshdi) {
                            console.log(`[UAFlix] Handling Ashdi Movie direct parse: ${player.src}`);
                            const ashdiLinks = await getLinksFromAshdiUrl(player.src, title || targetUa, null, fullPosterUrl);
                            if (ashdiLinks && ashdiLinks.length > 0) {
                                ashdiLinks.forEach(link => {
                                    ashdiResults.push({
                                        title: link.title || providerName,
                                        file: link.file,
                                        poster: link.poster || fullPosterUrl,
                                        subtitle: link.subtitle
                                    });
                                });
                            }
                            continue;
                        }

                        let m3u8Link = "";
                        let subtitlesArr = [];

                        const iframeRes = await axios.get(player.src, { 
                            headers: { ...HEADERS, 'Referer': contentUrl },
                            ...axiosConfig 
                        });
                        const iframeHtml = iframeRes.data;

                        const fileMatch = iframeHtml.match(/file:\s?["']([^"']+\.m3u8)["']/);
                        if (fileMatch) m3u8Link = fileMatch[1];
                        else {
                            const rawMatch = iframeHtml.match(/https?:\/\/[^\s"']+\.m3u8/);
                            if (rawMatch) m3u8Link = rawMatch[0];
                        }

                        if (m3u8Link) {
                            const subMatch = iframeHtml.match(/(?:subtitle|subtitles):\s?["']([^"']+)["']/i);
                            if (subMatch) {
                                const regex = /\[([^\]]+)\]([^,]+)/g;
                                let match;
                                while ((match = regex.exec(subMatch[1])) !== null) {
                                    subtitlesArr.push({ label: match[1], url: match[2] });
                                }
                            }

                            let proxyLink = `${host}/api/uaflix/proxy/master.m3u8?url=${encodeURIComponent(m3u8Link)}&referer=${encodeURIComponent(player.src)}`;
                            if (subtitlesArr.length > 0) {
                                proxyLink += `&subtitles=${encodeURIComponent(JSON.stringify(subtitlesArr))}`;
                            }

                            const item = {
                                title: providerName,
                                file: proxyLink,
                                poster: fullPosterUrl,
                                subtitle: subtitlesArr.length > 0 ? subtitlesArr : null,
                            };
                            if (isAshdi) ashdiResults.push(item);
                            else uaflixResults.push(item);
                        }
                    } catch (err) {
                        console.error(`Error processing player ${player.name}:`, err.message);
                    }
                }
                if (!ashdiResults.length && !uaflixResults.length) return null;
                const routes = {};
                if (ashdiResults.length) routes.ashdi = ashdiResults;
                if (uaflixResults.length) routes.uaflix = uaflixResults;
                return { _routes: routes };
            }

            // --- СЕРІАЛИ (TV) ---
            if (type === 'tv') {
                console.log('[UAFlix] Processing TV Show...');
                const showRes = await axios.get(contentUrl, { headers: HEADERS, ...axiosConfig });
                const $$ = cheerio.load(showRes.data);
                
                const episodesMap = {};
                let allEpisodesList = [];

                const episodeItems = $$('#sers-wr .video-item');
                console.log(`[UAFlix] Found ${episodeItems.length} episodes on series page`);

                episodeItems.each((i, el) => {
                    const link = $$(el).find('a.vi-img').attr('href');
                    const thumb = $$(el).find('img').attr('data-src') || $$(el).find('img').attr('src');
                    const fullThumb = thumb && !thumb.startsWith('http') ? BASE_URL + thumb : thumb;
                    const titleText = $$(el).find('.vi-title').text().trim();
                    const descRate = $$(el).find('.vi-rate').text().trim();

                    if (link) {
                        const seasonMatch = titleText.match(/Сезон\s+(\d+)/i);
                        const episodeMatch = titleText.match(/Серія\s+(\d+)/i);
                        const seasonNum = seasonMatch ? parseInt(seasonMatch[1]) : 1;
                        const episodeNum = episodeMatch ? parseInt(episodeMatch[1]) : i + 1;

                        if (!episodesMap[seasonNum]) episodesMap[seasonNum] = [];

                        episodesMap[seasonNum].push({
                            title: `Серія ${episodeNum}${descRate ? ' - ' + descRate : ''}`,
                            pageUrl: link, 
                            poster: fullThumb,
                            season: seasonNum,
                            episode: episodeNum
                        });
                        allEpisodesList.push({
                            season: seasonNum,
                            episode: episodeNum,
                            url: link
                        });
                    }
                });

                const finalResult = [];
                const ashdiSerialResult = [];

                // --- Single iframe serial (no separate episode pages, e.g. zetvideo) ---
                if (episodeItems.length === 0) {
                    console.log('[UAFlix] No episode items found, checking for single serial iframe');
                    const tabs = $$('.tabs-sel .tabs-link');
                    const contents = $$('.tabs-b.video-box');
                    
                    for (let ti = 0; ti < Math.max(tabs.length, 1); ti++) {
                        const tabName = tabs.length > 0 ? $$(tabs[ti]).text().trim() : 'Основний';
                        const contentDiv = contents.length > 0 ? contents.eq(ti) : $$('.video-box').first();
                        const iframeSrc = contentDiv.find('iframe').attr('src') || $$('iframe').attr('src');
                        
                        if (!iframeSrc) continue;
                        console.log(`[UAFlix] Single-iframe tab ${ti}: ${tabName} -> ${iframeSrc}`);

                        // Ashdi serial
                        if (iframeSrc.includes('ashdi.vip/serial/')) {
                            const cleanUrl = iframeSrc.split('?')[0];
                            const parsed = await getLinksFromAshdiUrl(cleanUrl, title || '');
                            if (parsed && parsed.length > 0) {
                                const voicesMap = {};
                                parsed.forEach(ep => {
                                    const v = ep.name || ep.voice || tabName;
                                    if (!voicesMap[v]) voicesMap[v] = [];
                                    voicesMap[v].push(ep);
                                });
                                for (const [voiceName, eps] of Object.entries(voicesMap)) {
                                    const seasonsMap = {};
                                    eps.forEach(ep => {
                                        const sn = ep.season || 1;
                                        if (!seasonsMap[sn]) seasonsMap[sn] = [];
                                        seasonsMap[sn].push(ep);
                                    });
                                    const playlist = Object.keys(seasonsMap).sort((a,b)=>a-b).map(sn => ({
                                        title: `Сезон ${sn}`,
                                        folder: seasonsMap[sn].sort((a,b)=>(a.episode||0)-(b.episode||0))
                                    }));
                                    ashdiSerialResult.push({ title: voiceName, folder: playlist });
                                }
                                continue;
                            }
                        }

                        // Zetvideo serial or other embedded player
                        try {
                            const iframeRes = await axios.get(iframeSrc, {
                                headers: { ...HEADERS, 'Referer': contentUrl },
                                ...axiosConfig
                            });
                            const iframeHtml = iframeRes.data;

                            // Parse file: JSON from playerjs init
                            const fileMatch = iframeHtml.match(/file\s*:\s*'(\[[\s\S]*?\])'\s*[,}]/);
                            if (fileMatch) {
                                let playlist;
                                try { playlist = JSON.parse(fileMatch[1]); } catch(e) { playlist = null; }

                                if (Array.isArray(playlist) && playlist.length > 0) {
                                    console.log(`[UAFlix] Parsed zetvideo serial: ${playlist.length} voice(s)`);
                                    
                                    for (const voice of playlist) {
                                        const voiceName = (voice.title || tabName).trim();
                                        const seasons = Array.isArray(voice.folder) ? voice.folder : [];

                                        const seasonFolders = seasons.map(season => {
                                            const seasonTitle = (season.title || 'Сезон 1').trim();
                                            const episodes = Array.isArray(season.folder) ? season.folder : [];

                                            const seasonMatch = seasonTitle.match(/(\d+)/);
                                            const sNum = seasonMatch ? parseInt(seasonMatch[1]) : 1;

                                            const epItems = episodes.map((ep, ei) => {
                                                const epTitle = (ep.title || `Серія ${ei + 1}`).trim();
                                                const epMatch = epTitle.match(/(\d+)/);
                                                const eNum = epMatch ? parseInt(epMatch[1]) : ei + 1;

                                                const m3u8 = ep.file || '';
                                                const poster = ep.poster || '';
                                                const subtitle = ep.subtitle || '';

                                                let proxyLink = `${host}/api/uaflix/proxy/master.m3u8?url=${encodeURIComponent(m3u8)}&referer=${encodeURIComponent(iframeSrc)}`;
                                                if (subtitle) {
                                                    const subs = [{ label: 'Українська', url: subtitle }];
                                                    proxyLink += `&subtitles=${encodeURIComponent(JSON.stringify(subs))}`;
                                                }

                                                return {
                                                    title: epTitle,
                                                    file: proxyLink,
                                                    poster: poster,
                                                    season: sNum,
                                                    episode: eNum
                                                };
                                            });

                                            return { title: seasonTitle, folder: epItems };
                                        });

                                        finalResult.push({ title: voiceName, folder: seasonFolders });
                                    }
                                    continue;
                                }
                            }

                            // Fallback: single m3u8 from iframe
                            const m3u8Match = iframeHtml.match(/file:\s?["']([^"']+\.m3u8)["']/);
                            if (m3u8Match) {
                                const proxyLink = `${host}/api/uaflix/proxy/master.m3u8?url=${encodeURIComponent(m3u8Match[1])}&referer=${encodeURIComponent(iframeSrc)}`;
                                finalResult.push({
                                    title: tabName,
                                    file: proxyLink,
                                    poster: fullPosterUrl
                                });
                            }
                        } catch (iframeErr) {
                            console.error(`[UAFlix] Error fetching single iframe: ${iframeErr.message}`);
                        }
                    }

                    if (!ashdiSerialResult.length && !finalResult.length) return null;
                    const routes = {};
                    if (ashdiSerialResult.length) routes.ashdi = ashdiSerialResult;
                    if (finalResult.length) routes.uaflix = finalResult;
                    return { _routes: routes };
                }

                // --- Multi-episode page flow ---
                let firstEpisodeUrl = null;
                if (allEpisodesList.length > 0) {
                    allEpisodesList.sort((a, b) => {
                        if (a.season !== b.season) return a.season - b.season;
                        return a.episode - b.episode;
                    });
                    firstEpisodeUrl = allEpisodesList[0].url;
                    console.log(`[UAFlix] Selecting oldest episode: S${allEpisodesList[0].season}E${allEpisodesList[0].episode}`);
                }

                if (firstEpisodeUrl) {
                    console.log(`[UAFlix] Going to first episode: ${firstEpisodeUrl}`);
                    try {
                        const epPageRes = await axios.get(firstEpisodeUrl, { headers: HEADERS, ...axiosConfig });
                        const $ep = cheerio.load(epPageRes.data);
                        
                        const tabs = $ep('.tabs-sel .tabs-link');
                        const contents = $ep('.tabs-b.video-box');

                        if (tabs.length > 0) {
                            console.log(`[UAFlix] Found ${tabs.length} player tabs on episode page`);
                            for (let i = 0; i < tabs.length; i++) {
                                const tabName = $ep(tabs[i]).text().trim();
                                const contentDiv = contents.eq(i);
                                const iframeSrc = contentDiv.find('iframe').attr('src');
                                
                                if (!iframeSrc) continue;
                                console.log(`[UAFlix] Player ${i}: ${tabName} -> ${iframeSrc}`);

                                if (iframeSrc.includes('ashdi.vip/serial/')) {
                                    console.log(`[UAFlix] Handling Ashdi Serial direct parse...`);
                                    const cleanIframeUrl = iframeSrc.split('?')[0];
                                    const parsedEpisodes = await getLinksFromAshdiUrl(cleanIframeUrl, title || targetUa);
                                    
                                    if (parsedEpisodes && parsedEpisodes.length > 0) {
                                        const voicesMap = {};
                                        parsedEpisodes.forEach(ep => {
                                            if (!voicesMap[ep.voice]) voicesMap[ep.voice] = [];
                                            voicesMap[ep.voice].push(ep);
                                        });

                                        for (const [voiceName, eps] of Object.entries(voicesMap)) {
                                            const seasonsMap = {};
                                            eps.forEach(ep => {
                                                if (!seasonsMap[ep.season]) seasonsMap[ep.season] = [];
                                                seasonsMap[ep.season].push(ep);
                                            });

                                            const playlist = Object.keys(seasonsMap).sort((a,b)=>a-b).map(sn => ({
                                                title: `Сезон ${sn}`,
                                                folder: seasonsMap[sn].sort((a,b)=>a.episode-b.episode)
                                            }));

                                            ashdiSerialResult.push({
                                                title: voiceName,
                                                folder: playlist,
                                            });
                                        }
                                        continue; 
                                    }
                                }

                                // Fallback (zetvideo або інше джерело)
                                const isAshdiTab = iframeSrc.includes('ashdi.vip') || tabName.toLowerCase().includes('ashdi');
                                let providerName = tabName;

                                const seasons = Object.keys(episodesMap).sort((a, b) => a - b);
                                const playlist = seasons.map(seasonNum => {
                                    const episodes = episodesMap[seasonNum]
                                        .sort((a, b) => a.episode - b.episode)
                                        .map(ep => ({
                                            title: ep.title,
                                            file: `${host}/api/uaflix/stream/master.m3u8?url=${encodeURIComponent(ep.pageUrl)}&player=${i}`,
                                            poster: ep.poster,
                                            season: ep.season,
                                            episode: ep.episode
                                        }));
                                    return { title: `Сезон ${seasonNum}`, folder: episodes };
                                });

                                const targetArr = isAshdiTab ? ashdiSerialResult : finalResult;
                                const existing = targetArr.find(r => r.title === providerName);
                                if (existing) providerName += ` ${i + 1}`;

                                targetArr.push({ title: providerName, folder: playlist });
                            }
                        } else {
                            console.log('[UAFlix] No tabs found, checking single video-box');
                            const iframeSrc = $ep('.video-box iframe').attr('src');
                            
                            if (iframeSrc && iframeSrc.includes('ashdi.vip/serial/')) {
                                console.log('[UAFlix] Found single Ashdi Serial iframe');
                                const cleanIframeUrl = iframeSrc.split('?')[0];
                                const parsedEpisodes = await parseAshdiPlaylist(cleanIframeUrl);
                                if (parsedEpisodes && parsedEpisodes.length > 0) {
                                    const voicesMap = {};
                                    parsedEpisodes.forEach(ep => {
                                        if (!voicesMap[ep.voice]) voicesMap[ep.voice] = [];
                                        voicesMap[ep.voice].push(ep);
                                    });
                                     for (const [voiceName, eps] of Object.entries(voicesMap)) {
                                         const seasonsMap = {};
                                         eps.forEach(ep => {
                                             if (!seasonsMap[ep.season]) seasonsMap[ep.season] = [];
                                             seasonsMap[ep.season].push(ep);
                                         });
                                         const playlist = Object.keys(seasonsMap).sort((a,b)=>a-b).map(sn => ({
                                             title: `Сезон ${sn}`,
                                             folder: seasonsMap[sn].sort((a,b)=>a.episode-b.episode)
                                         }));
                                         ashdiSerialResult.push({
                                             title: voiceName,
                                             folder: playlist,
                                         });
                                    }
                                }
                            } else if (iframeSrc) {
                                const isAshdiSingle = iframeSrc.includes('ashdi');
                                const providerName = 'Основний';
                                const seasons = Object.keys(episodesMap).sort((a, b) => a - b);
                                const playlist = seasons.map(seasonNum => {
                                    const episodes = episodesMap[seasonNum]
                                        .sort((a, b) => a.episode - b.episode)
                                        .map(ep => ({
                                            title: ep.title,
                                            file: `${host}/api/uaflix/stream/master.m3u8?url=${encodeURIComponent(ep.pageUrl)}&player=0`,
                                            poster: ep.poster,
                                            season: ep.season,
                                            episode: ep.episode
                                        }));
                                    return { title: `Сезон ${seasonNum}`, folder: episodes };
                                });
                                if (isAshdiSingle) ashdiSerialResult.push({ title: providerName, folder: playlist });
                                else finalResult.push({ title: providerName, folder: playlist });
                            }
                        }
                    } catch (e) {
                        console.error('[UAFlix] Error processing serial episode page:', e.message);
                    }
                }

                if (!ashdiSerialResult.length && !finalResult.length) return null;
                const routes = {};
                if (ashdiSerialResult.length) routes.ashdi = ashdiSerialResult;
                if (finalResult.length) routes.uaflix = finalResult;
                return { _routes: routes };
            }

        } catch (e) {
            console.error(`Uaflix Provider Error: ${e.message}`);
            return null;
        }
    }
};

async function searchUaflix(query, year, config) {
    try {
        const searchUrl = `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
        const { data } = await axios.get(searchUrl, { headers: HEADERS, ...config, timeout: 5000 });
        const $ = cheerio.load(data);
        
        let candidates = [];
        $('.sres-wrap').each((i, el) => {
            const elTitle = $(el).find('.sres-text h2').text().trim();
            const link = $(el).attr('href');
            const img = $(el).find('img').attr('src');
            const desc = $(el).text(); 
            const yearMatch = desc.match(/\b(19|20)\d{2}\b/);
            const foundYear = yearMatch ? yearMatch[0] : null;

            candidates.push({ rawTitle: elTitle, link, img, year: foundYear });
        });
        return candidates;
    } catch (e) {
        return [];
    }
}