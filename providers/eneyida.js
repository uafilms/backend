// Site: eneyida.tv → Provider: HDVB

const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');
const { parseHdvbIframe } = require('./hdvb');

const BASE_URL = 'https://eneyida.tv';

module.exports = {
    getLinks: async (title, year, signal) => {
        console.log('[Eneyida] Searching for:', title, year);
        const axiosConfig = proxyManager.getConfig('eneyida');
        try {
            const searchRes = await axios.post(`${BASE_URL}/index.php?do=search`,
                `do=search&subaction=search&story=${encodeURIComponent(title)}`,
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    ...axiosConfig,
                    timeout: 15000,
                    ...(signal ? { signal } : {})
                }
            );
            const $ = cheerio.load(searchRes.data);
            let movieLink = null;
            $('article').each((i, el) => {
                const link = $(el).find('a').attr('href');
                const titleText = $(el).find('.short-title, h2, a').text().toLowerCase();
                const textContent = $(el).text();
                const yearRegex = new RegExp(`(?<!\\d)${year}(?!\\d)`);
                const hasYear = year && yearRegex.test(textContent);
                const hasTitle = titleText.includes(title.toLowerCase());
                if (link && hasYear && hasTitle) { movieLink = link; return false; }
            });
            if (!movieLink) return null;

            const moviePage = await axios.get(movieLink, { ...axiosConfig, timeout: 15000, ...(signal ? { signal } : {}) });
            const iframeSrc = moviePage.data.match(/src="(https?:\/\/[^\/]+\/[^\"]+\/[0-9]+)"/)?.[1];
            if (!iframeSrc) return null;

            const parsed = await parseHdvbIframe(iframeSrc, `${BASE_URL}/`);
            if (!parsed) return null;
            // Filter out invalid results (empty file, broken JSON)
            const valid = Array.isArray(parsed) 
                ? parsed.filter(item => item && (item.file || item.folder))
                : (parsed.file || parsed.folder ? parsed : null);
            if (!valid || (Array.isArray(valid) && !valid.length)) return null;
            const result = Array.isArray(valid) ? valid : [valid];
            return { _routes: { hdvb: result } };
        } catch (e) {
            if (axios.isCancel(e)) return null;
            console.error('[Eneyida] getLinks error:', e.message);
            return null;
        }
    }
};
