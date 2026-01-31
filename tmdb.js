const axios = require('axios');

// Функція для отримання конфігурації (щоб підхопити ENV, якщо він завантажився пізніше)
const getConfig = () => {
    const token = process.env.TMDB_TOKEN;
    if (!token) {
        console.error('[TMDB] CRITICAL ERROR: TMDB_TOKEN is missing in environment variables!');
    }
    return {
        headers: {
            Authorization: `Bearer ${token}`,
            accept: 'application/json'
        }
    };
};

module.exports = {
    details: async (type, id) => {
        try {
            return (await axios.get(`https://api.themoviedb.org/3/${type}/${id}?language=uk-UA`, getConfig())).data;
        } catch (e) {
            console.error(`[TMDB] Error fetching details for ${type}/${id}:`, e.message);
            throw e;
        }
    },

    getExternalIds: async (id, isTv) => {
        const type = isTv ? 'tv' : 'movie';
        try {
            // Отримуємо зовнішні ID
            const res = await axios.get(`https://api.themoviedb.org/3/${type}/${id}/external_ids`, getConfig());
            return res.data;
        } catch (e) {
            console.error(`[TMDB] Error fetching External IDs for ${type}/${id}:`, e.response?.status, e.message);
            // Якщо 404 або 401 - повертаємо null, але ми побачимо це в логах
            return null;
        }
    },

    getTrending: (timeWindow = 'week', type = 'all') => 
        axios.get(`https://api.themoviedb.org/3/trending/${type}/${timeWindow}?language=uk-UA`, getConfig()).then(r => r.data),

    getRecommended: (type = 'movie', includeAdult = false) => 
        axios.get(`https://api.themoviedb.org/3/discover/${type}?language=uk-UA&sort_by=popularity.desc&include_adult=${includeAdult}`, getConfig()).then(r => r.data),

    getUkrainian: (type = 'movie', includeAdult = false) => 
        axios.get(`https://api.themoviedb.org/3/discover/${type}?language=uk-UA&with_origin_country=UA&with_original_language=uk&sort_by=popularity.desc&include_adult=${includeAdult}`, getConfig()).then(r => r.data),

    getCartoons: (type = 'movie', includeAdult = false) => 
        axios.get(`https://api.themoviedb.org/3/discover/${type}?language=uk-UA&with_genres=16&sort_by=popularity.desc&include_adult=${includeAdult}`, getConfig()).then(r => r.data),

    getAnime: (type = 'movie', includeAdult = false) => 
        axios.get(`https://api.themoviedb.org/3/discover/${type}?language=uk-UA&with_genres=16&with_origin_country=JP&sort_by=popularity.desc&include_adult=${includeAdult}`, getConfig()).then(r => r.data),
    
    search: (query, page = 1, includeAdult = false) => 
        axios.get(`https://api.themoviedb.org/3/search/multi?language=uk-UA&query=${encodeURIComponent(query)}&page=${page}&include_adult=${includeAdult}`, getConfig())
            .then(r => {
                if (r.data && r.data.results) {
                    r.data.results = r.data.results.filter(item => item.media_type !== 'person');
                }
                return r.data;
            }),
};