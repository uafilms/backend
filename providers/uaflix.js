const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');

const BASE_URL = 'https://uafix.net';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Referer': BASE_URL
};

// --- Ashdi Helper Logic ---
const ASHDI_PROXY_HOST = 'ashdi.aartzz.pp.ua';

function getAshdiProxyUrl(url) {
    if (!url) return '';
    const cleanUrl = url.split('?')[0];
    return cleanUrl.replace('ashdi.vip', ASHDI_PROXY_HOST);
}

async function parseAshdiPlaylist(iframeUrl) {
    try {
        const proxyUrl = getAshdiProxyUrl(iframeUrl);
        console.log(`[UAFlix] Ashdi Request: ${proxyUrl}`);
        
        const headers = {
            'User-Agent': HEADERS['User-Agent'],
            'Referer': 'https://ashdi.vip/',
            'Origin': 'https://ashdi.vip'
        };

        const response = await axios.get(proxyUrl, { headers });
        const html = response.data;

        // ВАЖЛИВО: Оновлений regex для багаторядкового JSON
        const fileMatch = html.match(/file:\s*'(\[\s*\{[\s\S]+?\}\s*\])'/);
        
        if (!fileMatch) {
            console.log('[UAFlix] Ashdi JSON not found in iframe via regex');
            const simpleMatch = html.match(/file:\s*'(\[.+?\])'/s);
            if (!simpleMatch) return null;
            
            try {
                let jsonStr = simpleMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
                const playlistData = JSON.parse(jsonStr);
                return processAshdiJson(playlistData);
            } catch (e) {
                console.log('[UAFlix] JSON Parse error (fallback):', e.message);
                return null;
            }
        }

        let jsonStr = fileMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
        const playlistData = JSON.parse(jsonStr);
        return processAshdiJson(playlistData);

    } catch (e) {
        console.error('Ashdi Parse Error:', e.message);
        return null;
    }
}

function processAshdiJson(playlistData) {
    const resultPlaylist = [];

    playlistData.forEach(voice => {
        const voiceName = (voice.title || 'Original').trim();
        if (voice.folder) {
            voice.folder.forEach(seasonObj => {
                const seasonMatch = seasonObj.title.match(/(\d+)/);
                const seasonNum = seasonMatch ? parseInt(seasonMatch[1]) : 1;
                if (seasonObj.folder) {
                    seasonObj.folder.forEach(epObj => {
                        const epMatch = epObj.title.match(/(\d+)/);
                        const epNum = epMatch ? parseInt(epMatch[1]) : 1;
                        resultPlaylist.push({
                            season: seasonNum,
                            episode: epNum,
                            title: epObj.title,
                            file: epObj.file,
                            voice: voiceName,
                            subtitle: epObj.subtitle || null,
                            provider: 'Ashdi' // Це поле може бути використане агрегатором
                        });
                    });
                }
            });
        }
    });
    return resultPlaylist;
}

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

                const results = [];
                for (const player of players) {
                    try {
                        let providerName = `UaFlix - ${player.name}`;
                        if (player.src.includes('ashdi.vip') || player.name.toLowerCase().includes('ashdi')) {
                            // providerName = 'Ashdi'; // Видаляємо це, щоб не дублювати назву
                            // Якщо це Ashdi, ми можемо спробувати повернути "Ashdi" як ім'я провайдера
                            // Але структура тут: providerName йде в 'title', який потім стає 'dub'
                        }
                        
                        // Спрощуємо назву для Movie
                        if (player.name.toLowerCase().includes('ashdi')) {
                            providerName = 'Ashdi';
                        } else {
                            providerName = player.name; // Просто "Озвучка X" без "Uaflix - "
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

                            results.push({
                                title: providerName,
                                file: proxyLink,
                                poster: fullPosterUrl,
                                subtitle: subtitlesArr.length > 0 ? subtitlesArr : null,
                                provider: 'Ashdi' // Спробуємо підказати агрегатору
                            });
                        }
                    } catch (err) {
                        console.error(`Error processing player ${player.name}:`, err.message);
                    }
                }
                return results.length > 0 ? results : null;
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

                                            finalResult.push({
                                                title: voiceName, // БУЛО: `Ashdi (${voiceName})`. СТАЛО: просто ім'я озвучки
                                                folder: playlist,
                                                provider: 'Ashdi' // Додаємо маркер для агрегатора
                                            });
                                        }
                                        continue; 
                                    }
                                }

                                // Fallback
                                let providerName = tabName; // БУЛО: `UaFlix - ${tabName}`
                                if (iframeSrc.includes('ashdi.vip/vod/') || tabName.toLowerCase().includes('ashdi')) {
                                    // Якщо назва табу містить Ashdi, можна просто залишити "Ashdi" або "Озвучка"
                                    // Але часто tabName це і є озвучка.
                                    // Якщо хочемо об'єднати всі Ashdi VOD під одним ім'ям:
                                    // providerName = 'Ashdi'; 
                                }

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

                                const existing = finalResult.find(r => r.title === providerName);
                                if (existing) providerName += ` ${i + 1}`;

                                finalResult.push({ title: providerName, folder: playlist });
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
                                         finalResult.push({
                                             title: voiceName, // Без "Ashdi"
                                             folder: playlist,
                                             provider: 'Ashdi'
                                         });
                                    }
                                }
                            } else if (iframeSrc) {
                                let providerName = 'Основний';
                                if (iframeSrc.includes('ashdi')) providerName = 'Ashdi';
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
                                finalResult.push({ title: providerName, folder: playlist });
                            }
                        }
                    } catch (e) {
                        console.error('[UAFlix] Error processing serial episode page:', e.message);
                    }
                }

                return finalResult.length > 0 ? finalResult : null;
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