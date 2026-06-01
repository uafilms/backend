// Site: wh.lme.isroot.in (Wormhole) → Provider: Ashdi

const axios = require('axios');
const proxyManager = require('../utils/proxyManager');
const { getLinksFromAshdiUrl, BASE_HEADERS } = require('./ashdi');

const WORMHOLE_URL = 'https://wh.lme.isroot.in';

module.exports = {
    getLinks: async (imdbId, title, signal) => {
        console.log('[Wormhole] Searching for:', title);
        if (!imdbId) return null;
        const axiosConfig = proxyManager.getConfig('wormhole');
        try {
            const { data } = await axios.get(`${WORMHOLE_URL}/?imdb_id=${imdbId}`, {
                headers: BASE_HEADERS,
                timeout: 10000,
                ...axiosConfig,
                ...(signal ? { signal } : {})
            });
            const ashdiUrl = data?.play;
            if (!ashdiUrl || typeof ashdiUrl !== 'string' || !ashdiUrl.includes('ashdi')) return null;
            const parsed = await getLinksFromAshdiUrl(ashdiUrl, title);
            if (!parsed || !parsed.length) return null;
            return { _routes: { ashdi: parsed } };
        } catch (e) {
            if (axios.isCancel(e)) return null;
            console.error('[Wormhole] getLinks error:', e.message);
            return null;
        }
    }
};
