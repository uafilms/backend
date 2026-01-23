const axios = require('axios');
const proxyManager = require('../utils/proxyManager');

const API_KEY = '865fEF-E2e1Bc-2ca431-e6A150-780DFD-737C6B';
const API_HOST = 'https://api.moonanime.art';

module.exports = {
    getLinks: async (imdb_id, title, year, host) => {
        const axiosConfig = proxyManager.getConfig('moonanime');
        try {
            const searchRes = await axios.get(`${API_HOST}/api/2.0/titles`, {
                params: { api_key: API_KEY, imdbid: imdb_id, search: title },
                headers: { 'origin': 'http://lampa.mx' },
                ...axiosConfig
            });

            const anime = (searchRes.data.anime_list || []).find(i => i.year == year) || searchRes.data.anime_list?.[0];
            if (!anime) return null;

            const videoRes = await axios.get(`${API_HOST}/api/2.0/title/${anime.id}/videos`, {
                params: { api_key: API_KEY },
                ...axiosConfig
            });

            // Трансформація [ { "Studio": { "Season": [Episodes] } } ] -> [ { "title": "Studio", "folder": [...] } ]
            const playlist = videoRes.data.map(transObj => {
                const transName = Object.keys(transObj)[0];
                const seasons = transObj[transName];
                
                // ВИПРАВЛЕННЯ: Якщо об'єкт сезонів порожній або не існує, пропускаємо цю озвучку
                if (!seasons || Object.keys(seasons).length === 0) {
                    return null;
                }

                return {
                    title: transName,
                    folder: Object.keys(seasons).map(sNum => ({
                        title: `${sNum} сезон`,
                        folder: seasons[sNum].map(ep => {
                            const vodId = ep.vod.split('/').filter(Boolean).pop();
                            return {
                                title: ep.title || `${ep.episode} серія`,
                                file: `${host}/api/moonanime/stream/${vodId}`,
                                id: vodId,
                                poster: ep.poster,
                                subtitle: ""
                            };
                        })
                    }))
                };
            }).filter(Boolean); // Фільтруємо null значення (пусті озвучки)

            // Якщо після фільтрації список пустий - повертаємо null, щоб джерело не відображалось
            if (playlist.length === 0) return null;

            return playlist;
        } catch (e) { return null; }
    }
};