const axios = require('axios');
const proxyManager = require('../utils/proxyManager');

function decodeTortuga(encoded) {
    try {
        let decoded = Buffer.from(encoded.replace(/==$/, ""), 'base64').toString('utf-8');
        return decoded.split('').reverse().join('');
    } catch (e) { return encoded; }
}

module.exports = {
    getLinks: async (title, year) => {
        const axiosConfig = proxyManager.getConfig('tortuga');
        try {
            const fbRes = await axios.get(`http://194.246.82.144/ukr?eng_name=${encodeURIComponent(title)}`, {
                ...axiosConfig
            });
            const match = fbRes.data.find(i => i.year == year);
            let iframeSrc = match?.tortuga;

            if (!iframeSrc) {
                const searchRes = await axios.post('https://tortuga.wtf/index.php?do=search', 
                    `do=search&subaction=search&story=${encodeURIComponent(title)}`,
                    { 
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://tortuga.wtf/' },
                        ...axiosConfig
                    }
                );
                const movieLink = searchRes.data.match(/href="(https?:\/\/tortuga\.wtf\/[^\"]+\.html)"/)?.[1];
                if (movieLink) {
                    const page = await axios.get(movieLink, axiosConfig);
                    iframeSrc = page.data.match(/src="(https?:\/\/tortuga\.[a-z]+\/[^\"]+)"/)?.[1];
                }
            }

            if (!iframeSrc) return null;

            const content = await axios.get(iframeSrc, axiosConfig);
            const html = content.data;
            const getParam = (p) => (html.match(new RegExp(`${p}:\\s?['"]([^'"]+)['"]`)) || [])[1] || null;

            const fileMatch = html.match(/file:\s?['"](\[[\s\S]*?\]|[^'"]+)['"]/);
            if (!fileMatch) return null;

            let fileData = fileMatch[1];

            // Якщо це СЕРІАЛ (масив JSON)
            if (fileData.startsWith('[')) {
                try {
                    return JSON.parse(fileData); // Повертаємо масив об'єктів напряму
                } catch (e) { return null; }
            }

            // Якщо це ФІЛЬМ (пряме посилання)
            if (fileData.endsWith("==") || !fileData.includes("http")) {
                fileData = decodeTortuga(fileData);
            }

            return {
                file: fileData,
                poster: getParam('poster'),
                subtitle: getParam('subtitle'),
                skip: getParam('skip'),
                thumbnails: getParam('thumbnails')
            };
        } catch (e) { return null; }
    }
};