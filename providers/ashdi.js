const axios = require('axios');
const proxyManager = require('../utils/proxyManager');
const tmdb = require('../tmdb'); // Додано імпорт TMDB

module.exports = {
    getLinks: async (kpId, title, year) => {
        const proxy = 'https://ashdi.aartzz.pp.ua';
        const axiosConfig = proxyManager.getConfig('ashdi');
        try {
            let iframeSrc = null;

            // 1. Основне API
            if (kpId) {
                const apiRes = await axios.get(`${proxy}/api/product/read_api.php?kinopoisk=${kpId}`, {
                    ...axiosConfig
                }).catch(() => ({ data: "" }));
                iframeSrc = apiRes.data.match(/src="([^"]+)"/)?.[1];
            }

            // 2. Fallback
            if (!iframeSrc) {
                const fbRes = await axios.get(`http://194.246.82.144/ukr?eng_name=${encodeURIComponent(title)}`, {
                    ...axiosConfig
                });
                const match = fbRes.data.find(i => i.year == year);
                iframeSrc = match?.ashdi;
            }

            if (!iframeSrc) return null;

            const content = await axios.get(iframeSrc.replace('https://ashdi.vip', proxy), {
                ...axiosConfig
            });
            const html = content.data;
            const getParam = (p) => (html.match(new RegExp(`${p}:\\s?['"]([^'"]+)['"]`)) || [])[1] || null;

            // Шукаємо плейлист (масив) або прямий файл
            const fileMatch = html.match(/file:\s?['"](\[[\s\S]*?\]|http[^'"]+)['"]/);
            if (!fileMatch) return null;

            let fileData = fileMatch[1];

            // Якщо це плейлист (серіал)
            if (fileData.startsWith('[')) {
                try {
                    let playlist = JSON.parse(fileData);
                    // Виправляємо домени в усьому масиві
                    const fixStr = (s) => typeof s === 'string' ? s.replace(/0yql3tj/g, "oyql3tj") : s;
                    
                    const processFolder = (items) => items.map(item => ({
                        ...item,
                        file: fixStr(item.file),
                        folder: item.folder ? processFolder(item.folder) : undefined
                    }));
                    
                    return processFolder(playlist);
                } catch (e) { return null; }
            }

            // Якщо це фільм
            return {
                file: fileData.replace(/0yql3tj/g, "oyql3tj"),
                poster: getParam('poster'),
                subtitle: getParam('subtitle'),
                title: title
            };
        } catch (e) { return null; }
    },

    getStream: async (id, type, season, episode) => {
        try {
            // 1. Отримуємо метадані фільму/серіалу
            const info = await tmdb.details(type, id);
            const extIds = await tmdb.getExternalIds(id, type === 'tv');
            
            const kpId = extIds?.kinopoisk_id;
            const title = info.original_title || info.original_name;
            const year = (info.release_date || info.first_air_date || "").split("-")[0];

            // 2. Отримуємо структуру посилань через getLinks
            const links = await module.exports.getLinks(kpId, title, year);
            if (!links) return null;

            // 3. Шукаємо конкретний файл
            if (type === 'movie') {
                // Для фільму links - це об'єкт, але перевіримо на всяк випадок
                if (links.file) return { url: links.file, type: 'application/x-mpegURL' };
                if (Array.isArray(links) && links[0]?.file) return { url: links[0].file, type: 'application/x-mpegURL' };
            } else {
                // Для серіалу links - це масив папок/файлів
                if (!Array.isArray(links)) return null;

                let foundUrl = null;

                const traverse = (items, ctxSeason) => {
                    if (foundUrl) return;

                    for (const item of items) {
                        let s = ctxSeason;
                        let e = null;
                        const rawTitle = item.title || "";

                        // Парсинг сезону з назви папки
                        let sMatch = rawTitle.match(/(?:season|сезон|s)\s*(\d+)/i);
                        if (!sMatch) sMatch = rawTitle.match(/(\d+)\s*(?:season|сезон)/i);
                        if (sMatch) s = parseInt(sMatch[1]);

                        // Парсинг епізоду
                        let eMatch = rawTitle.match(/(?:episode|серія|ep|e)\s*(\d+)/i);
                        if (!eMatch) eMatch = rawTitle.match(/(\d+)\s*(?:episode|серія)/i);
                        if (eMatch) e = parseInt(eMatch[1]);

                        if (item.folder) {
                            traverse(item.folder, s);
                        } else if (item.file) {
                            if (s == season && e == episode) {
                                foundUrl = item.file;
                                return;
                            }
                        }
                    }
                };

                traverse(links, null);
                if (foundUrl) return { url: foundUrl, type: 'application/x-mpegURL' };
            }
        } catch (e) {
            console.error("Ashdi getStream error:", e);
        }
        return null;
    }
};