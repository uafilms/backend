const axios = require('axios');
// Твій токен
const TMDB_TOKEN = process.env.TMDB_TOKEN;
const config = { headers: { Authorization: `Bearer ${TMDB_TOKEN}`, accept: 'application/json' } };

module.exports = {
    details: (type, id) => axios.get(`https://api.themoviedb.org/3/${type}/${id}?language=uk-UA`, config).then(r => r.data),
    
    getExternalIds: async (id, isTv) => {
        const url = `https://lam.aartzz.pp.ua/externalids?id=${id}&serial=${isTv ? 1 : 0}&uid=gorod_phiptj`;
        try { return (await axios.get(url)).data; } catch (e) { return null; }
    },

    getTrending: (timeWindow = 'week', type = 'all') => 
        axios.get(`https://api.themoviedb.org/3/trending/${type}/${timeWindow}?language=uk-UA`, config).then(r => r.data),

    getRecommended: (type = 'movie', includeAdult = false) => 
        axios.get(`https://api.themoviedb.org/3/discover/${type}?language=uk-UA&sort_by=popularity.desc&include_adult=${includeAdult}`, config).then(r => r.data),

    getUkrainian: (type = 'movie', includeAdult = false) => {
        return axios.get(`https://api.themoviedb.org/3/discover/${type}?language=uk-UA&with_origin_country=UA&with_original_language=uk&sort_by=popularity.desc&include_adult=${includeAdult}`, config).then(r => r.data);
    },

    getCartoons: (type = 'movie', includeAdult = false) => 
        axios.get(`https://api.themoviedb.org/3/discover/${type}?language=uk-UA&with_genres=16&sort_by=popularity.desc&include_adult=${includeAdult}`, config).then(r => r.data),

    getAnime: (type = 'movie', includeAdult = false) => 
        axios.get(`https://api.themoviedb.org/3/discover/${type}?language=uk-UA&with_genres=16&with_origin_country=JP&sort_by=popularity.desc&include_adult=${includeAdult}`, config).then(r => r.data),
    
    search: (query, page = 1, includeAdult = false) => 
        axios.get(`https://api.themoviedb.org/3/search/multi?language=uk-UA&query=${encodeURIComponent(query)}&page=${page}&include_adult=${includeAdult}`, config)
            .then(r => {
                // ВИПРАВЛЕНО: Фільтруємо людей (person) з результатів пошуку
                if (r.data && r.data.results) {
                    r.data.results = r.data.results.filter(item => item.media_type !== 'person');
                }
                return r.data;
            }),
};