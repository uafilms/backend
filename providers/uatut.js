// Site: tv.uatut.fun → Provider: Ashdi

const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');
const { getLinksFromAshdiUrl, BASE_HEADERS } = require('./ashdi');

const UATUT_URL = 'https://tv.uatut.fun/watch';

module.exports = {
    getLinks: async (imdbId, title) => {
        const axiosConfig = proxyManager.getConfig('uatut');
        try {
            const query = imdbId || title;
            if (!query) return null;
            const { data: results } = await axios.get(`${UATUT_URL}/search.php?q=${encodeURIComponent(query)}`, {
                headers: BASE_HEADERS,
                timeout: 10000,
                ...axiosConfig
            });
            if (!Array.isArray(results) || !results.length) return null;
            const match = imdbId
                ? (results.find(r => r.imdb_id === imdbId) || results[0])
                : results[0];
            if (!match?.id) return null;
            const { data: html } = await axios.get(`${UATUT_URL}/${match.id}`, {
                headers: BASE_HEADERS,
                timeout: 10000,
                ...axiosConfig
            });
            const $ = cheerio.load(html);
            const ashdiSrc = $('iframe[src*="ashdi.vip"]').attr('src');
            if (!ashdiSrc) return null;
            const parsed = await getLinksFromAshdiUrl(ashdiSrc, title || match.title);
            if (!parsed || !parsed.length) return null;
            return { _routes: { ashdi: parsed } };
        } catch (e) {
            console.error('[UaTUT] getLinks error:', e.message);
            return null;
        }
    }
};
