const axios = require('axios');

const BASE_URL = 'https://cinepro.aartzz.pp.ua';

module.exports = {
    getLinks: async (metadata) => {
        if (metadata.type !== 'movie') return [];

        const tmdbId = metadata.id;
        if (!tmdbId) return [];

        try {
            const url = `${BASE_URL}/movie/${tmdbId}?providers=uembed`;
            const response = await axios.get(url, { validateStatus: false });

            if (response.status !== 200 || !response.data || !response.data.files) {
                return [];
            }

            const files = response.data.files;
            
            const subtitles = (response.data.subtitles || []).map(sub => ({
                label: sub.lang || 'English',
                lang: sub.lang || 'en',
                url: sub.url
            }));

            return files.map(file => {
                // Визначаємо якість для поля quality
                const qualityLabel = file.quality || (file.type === 'hls' ? 'Auto' : 'Unknown');

                return {
                    source: 'UEmbed',
                    name: 'English', // Прибрали якість з назви
                    url: file.file,
                    quality: qualityLabel,
                    subtitles: subtitles,
                    headers: file.headers || {}
                };
            });

        } catch (e) {
            console.error(`[UEmbed] Error fetching for ${tmdbId}:`, e.message);
            return [];
        }
    }
};