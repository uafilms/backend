// UafilmME provider
// Source discovered by lampame (https://github.com/lampame)
// API: uafilm.me — restreams from other providers (ashdi, etc.)

const axios = require('axios');

const BASE_URL = 'https://uafilm.me';
const API = `${BASE_URL}/api/v1`;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:149.0) Gecko/20100101 Firefox/149.0',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `${BASE_URL}/`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
};

function cleanTitle(s) {
    return (s || '')
        .toLowerCase()
        .replace(/[''`ʼ"]/g, '')
        .replace(/ё/g, 'е')
        .replace(/[^a-z0-9а-яіїєґ\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titlesMatch(a, b) {
    return cleanTitle(a) === cleanTitle(b);
}

async function searchTitle(title, year, type) {
    try {
        const query = encodeURIComponent(title);
        const { data } = await axios.get(`${API}/search/${query}?loader=searchAutocomplete`, {
            headers: HEADERS,
            timeout: 8000,
        });

        if (!data?.results?.length) return null;

        // Try exact match by title + year
        for (const r of data.results) {
            if (typeof r.id !== 'number') continue; // skip tmdb-only results (base64 ids)
            const nameMatch = titlesMatch(r.name, title) || titlesMatch(r.original_title, title);
            const yearMatch = !year || String(r.year) === String(year);
            if (nameMatch && yearMatch) return r;
        }

        // Fallback: first numeric-id result matching year
        for (const r of data.results) {
            if (typeof r.id !== 'number') continue;
            if (!year || String(r.year) === String(year)) return r;
        }

        return null;
    } catch (e) {
        console.error('[UafilmME] Search error:', e.message);
        return null;
    }
}

async function getVideosForTitle(titleId) {
    try {
        const { data } = await axios.get(`${API}/videos?title_id=${titleId}`, {
            headers: HEADERS,
            timeout: 10000,
        });

        const videos = data?.pagination?.data;
        if (!Array.isArray(videos)) return [];

        return videos.filter(v => v.category === 'full' && v.type === 'stream' && v.src);
    } catch (e) {
        console.error('[UafilmME] Videos fetch error:', e.message);
        return [];
    }
}

async function getVideoById(videoId) {
    try {
        const { data } = await axios.get(`${API}/videos/${videoId}`, {
            headers: HEADERS,
            timeout: 8000,
        });
        return data?.video || null;
    } catch (e) {
        console.error(`[UafilmME] Video ${videoId} fetch error:`, e.message);
        return null;
    }
}

async function getAllSeasons(titleId) {
    const seasons = [];
    let page = 1;
    const maxPages = 20;

    while (page <= maxPages) {
        try {
            const url = page === 1
                ? `${API}/titles/${titleId}?loader=titlePage`
                : `${API}/titles/${titleId}?loader=titlePage&seasonPage=${page}`;
            const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });

            const seasonsData = data?.seasons;
            if (!seasonsData?.data?.length) break;

            seasons.push(...seasonsData.data);

            if (!seasonsData.next_page) break;
            page = seasonsData.next_page;
        } catch (e) {
            console.error(`[UafilmME] Seasons page ${page} error:`, e.message);
            break;
        }
    }

    return seasons;
}

async function getAllEpisodes(titleId) {
    const episodes = [];
    let page = 1;
    const maxPages = 100;

    while (page <= maxPages) {
        try {
            const url = page === 1
                ? `${API}/titles/${titleId}?loader=titlePage`
                : `${API}/titles/${titleId}?loader=titlePage&episodePage=${page}`;
            const { data } = await axios.get(url, { headers: HEADERS, timeout: 10000 });

            const epsData = data?.episodes;
            if (!epsData?.data?.length) break;

            episodes.push(...epsData.data);

            if (!epsData.next_page) break;
            page = epsData.next_page;
        } catch (e) {
            console.error(`[UafilmME] Episodes page ${page} error:`, e.message);
            break;
        }
    }

    return episodes;
}

function buildSubtitles(captions) {
    if (!Array.isArray(captions) || !captions.length) return undefined;
    return captions
        .filter(c => c.url)
        .map(c => ({
            label: c.name || c.language || 'Subtitles',
            url: c.url,
            lang: (c.language || 'uk').substring(0, 2),
        }));
}

function originToRoute(origin) {
    if (!origin) return 'uafilmme';
    const o = origin.toLowerCase();
    if (o.includes('ashdi')) return 'ashdi';
    return o || 'uafilmme';
}

module.exports = {
    getLinks: async function (imdbId, title, year, host) {
        if (!title) return null;

        console.log(`[UafilmME] Searching: "${title}" (${year})`);
        const found = await searchTitle(title, year);
        if (!found) {
            console.log('[UafilmME] Not found');
            return null;
        }

        console.log(`[UafilmME] Found: id=${found.id} "${found.name}" (${found.year}) is_series=${found.is_series}`);

        // --- MOVIE ---
        if (!found.is_series) {
            const videos = await getVideosForTitle(found.id);
            if (!videos.length) return null;

            const routes = {};
            for (const v of videos) {
                const route = originToRoute(v.origin);
                if (!routes[route]) routes[route] = [];

                routes[route].push({
                    title: v.name || 'Українська',
                    file: v.src,
                    poster: found.poster || null,
                    subtitle: buildSubtitles(v.captions),
                });
            }

            console.log(`[UafilmME] Movie: ${videos.length} video(s), routes: [${Object.keys(routes).join(', ')}]`);
            return { _routes: routes };
        }

        // --- TV SERIES ---
        const episodes = await getAllEpisodes(found.id);
        if (!episodes.length) {
            console.log('[UafilmME] No episodes found');
            return null;
        }

        // Collect video IDs from primary_video
        const videoIds = episodes
            .filter(ep => ep.primary_video?.id)
            .map(ep => ({
                videoId: ep.primary_video.id,
                season: ep.season_number || ep.primary_video.season_num || 1,
                episode: ep.episode_number || ep.primary_video.episode_num || 1,
                name: ep.name,
            }));

        if (!videoIds.length) {
            console.log('[UafilmME] No episodes with video IDs');
            return null;
        }

        console.log(`[UafilmME] TV: ${videoIds.length} episodes with videos, fetching streams...`);

        // Fetch video details in parallel (batched)
        const BATCH_SIZE = 10;
        const routes = {};

        for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
            const batch = videoIds.slice(i, i + BATCH_SIZE);
            const videoPromises = batch.map(async (ep) => {
                const video = await getVideoById(ep.videoId);
                if (!video?.src) return null;
                return { ...ep, video };
            });

            const results = await Promise.all(videoPromises);
            for (const r of results) {
                if (!r) continue;

                const route = originToRoute(r.video.origin);
                if (!routes[route]) routes[route] = [];

                routes[route].push({
                    title: `Серія ${r.episode}`,
                    file: r.video.src,
                    poster: found.poster || null,
                    subtitle: buildSubtitles(r.video.captions),
                    season: r.season,
                    episode: r.episode,
                });
            }
        }

        if (!Object.keys(routes).length) return null;

        // Build folder structure per route: voice → seasons → episodes
        const result = {};
        for (const [route, items] of Object.entries(routes)) {
            // Group by season
            const seasonsMap = {};
            for (const item of items) {
                const s = item.season || 1;
                if (!seasonsMap[s]) seasonsMap[s] = [];
                seasonsMap[s].push(item);
            }

            const playlist = Object.keys(seasonsMap)
                .sort((a, b) => a - b)
                .map(sNum => ({
                    title: `Сезон ${sNum}`,
                    folder: seasonsMap[sNum]
                        .sort((a, b) => a.episode - b.episode)
                        .map(ep => ({
                            title: ep.title,
                            file: ep.file,
                            poster: ep.poster,
                            subtitle: ep.subtitle,
                            season: ep.season,
                            episode: ep.episode,
                        })),
                }));

            result[route] = [{ title: 'UafilmME', folder: playlist }];
        }

        const totalEps = Object.values(routes).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`[UafilmME] TV: ${totalEps} episodes, routes: [${Object.keys(result).join(', ')}]`);
        return { _routes: result };
    },
};
