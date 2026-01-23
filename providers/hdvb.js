const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');

module.exports = {
    getLinks: async (title, year) => {
        const axiosConfig = proxyManager.getConfig('hdvb');
        try {
            const searchRes = await axios.post('https://eneyida.tv/index.php?do=search', 
                `do=search&subaction=search&story=${encodeURIComponent(title)}`,
                { 
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    ...axiosConfig
                }
            );

            const $ = cheerio.load(searchRes.data);
            let movieLink = null;

            // Більш точний пошук за допомогою cheerio
            $('article').each((i, el) => {
                const link = $(el).find('a').attr('href');
                const titleText = $(el).find('.short-title, h2, a').text().toLowerCase();
                const textContent = $(el).text();
                
                // Перевіряємо, чи є рік у тексті (обмежений не-цифрами, щоб 2023 не знайшло в 202)
                const yearRegex = new RegExp(`(?<!\\d)${year}(?!\\d)`);
                const hasYear = yearRegex.test(textContent);
                
                // Перевіряємо входження назви
                const hasTitle = titleText.includes(title.toLowerCase());

                if (link && hasYear && hasTitle) {
                    movieLink = link;
                    return false; // break loop
                }
            });

            if (!movieLink) return null;

            const moviePage = await axios.get(movieLink, axiosConfig);
            const iframeSrc = moviePage.data.match(/src="(https?:\/\/[^\/]+\/[^\"]+\/[0-9]+)"/)?.[1];
            if (!iframeSrc) return null;

            const content = await axios.get(iframeSrc, { 
                headers: { 'Referer': 'https://eneyida.tv/' },
                ...axiosConfig 
            });
            const html = content.data;
            const getParam = (p) => (html.match(new RegExp(`${p}:\\s?['"]([^'"]+)['"]`)) || [])[1] || null;

            const fileMatch = html.match(/file:\s?['"](\[[\s\S]*?\]|http[^'"]+)['"]/);
            if (!fileMatch) return null;

            if (fileMatch[1].startsWith('[')) return JSON.parse(fileMatch[1]);

            return {
                file: fileMatch[1],
                poster: getParam('poster'),
                subtitle: getParam('subtitle')
            };
        } catch (e) { 
            console.error("HDVB Error:", e.message);
            return null; 
        }
    }
};