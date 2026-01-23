const axios = require('axios');

const API_URL = 'https://torrent.aartzz.pp.ua/film';

// Функція для очищення назви аудіо/субтитрів від технічних даних
function cleanTrackTitle(title) {
    if (!title) return '';

    return title
        // Видаляємо кодеки та формати
        .replace(/\b(DTS-HD\s?MA|DTS-HD|DTS|TrueHD|Atmos|AC-3|AC3|AAC|E-AC-3|DD\+|DD|FLAC|MP3|OPUS|Vorbis|PCM|LPCM)\b/gi, '')
        // Видаляємо бітрейт (1509 kbps, 640 kb/s)
        .replace(/\b\d{3,5}\s*k?bps\b/gi, '')
        .replace(/\b\d{1,3}\.?\d*\s*k?Hz\b/gi, '')
        // Видаляємо канали (5.1, 7.1, 2.0)
        .replace(/\b\d\.\d\b/g, '')
        .replace(/\b(ch|channels)\b/gi, '')
        // Видаляємо інше сміття
        .replace(/\b(bit|bits)\b/gi, '')
        .replace(/\b(Blu-?ray|BD|Remux|Rip)\b/gi, '')
        .replace(/\b(EUR|CEE)\b/gi, '')
        .replace(/@/g, '')
        // Видаляємо дужки та роздільники, замінюючи на пробіли
        .replace(/[\[\]\(\)]/g, ' ')
        .replace(/[\/\|\-,]/g, ' ')
        // Прибираємо зайві пробіли
        .replace(/\s+/g, ' ')
        .trim();
}

// Виправлено: функція приймає лише tmdbId та type, як ти просив
async function searchTorrents({ tmdbId, type }) {
    try {
        if (!tmdbId) {
            console.warn("SearchTorrents: TMDB ID is missing");
            return [];
        }

        const isSerial = (type === 'movie') ? 0 : 1;

        // Видалено title та year, залишено лише необхідні параметри для API
        const params = {
            tmdb: tmdbId,
            is_serial: isSerial
        };

        const response = await axios.get(API_URL, { 
            params,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000 
        });

        const results = response.data?.Results || [];

        return results.map(item => {
            const mediainfo = item.Mediainfo || [];
            
            // --- Парсинг Аудіо ---
            const audioTracks = mediainfo
                .filter(s => s.codec_type === 'audio')
                .map(s => {
                    let lang = (s.tags?.language || 'und').toUpperCase();
                    let rawTitle = s.tags?.title || '';
                    
                    if (lang === 'UND') {
                        if (rawTitle.toLowerCase().includes('ukr')) lang = 'UKR';
                        else if (rawTitle.toLowerCase().includes('rus')) lang = 'RUS';
                        else if (rawTitle.toLowerCase().includes('eng')) lang = 'ENG';
                        else if (rawTitle.toLowerCase().includes('jpn')) lang = 'JPN';
                    }

                    if (lang === 'UND') return null;

                    const cleanedTitle = cleanTrackTitle(rawTitle);
                    
                    if (cleanedTitle && cleanedTitle.toLowerCase() !== lang.toLowerCase()) {
                        return `${lang} - ${cleanedTitle}`;
                    }
                    return lang;
                })
                .filter(Boolean)
                .filter((v, i, a) => a.indexOf(v) === i);

            // --- Парсинг Субтитрів ---
            const subTracks = mediainfo
                .filter(s => s.codec_type === 'subtitle')
                .map(s => {
                    let lang = (s.tags?.language || 'und').toUpperCase();
                    let rawTitle = s.tags?.title || '';

                    if (lang === 'UND') {
                         if (rawTitle.toLowerCase().includes('ukr')) lang = 'UKR';
                         else if (rawTitle.toLowerCase().includes('eng')) lang = 'ENG';
                    }

                    if (lang === 'UND') return null;

                    const cleanedTitle = cleanTrackTitle(rawTitle);
                    
                    if (cleanedTitle) {
                        return `${lang} ${cleanedTitle}`; 
                    }
                    return lang;
                })
                .filter(Boolean)
                .filter((v, i, a) => a.indexOf(v) === i);

            return {
                ...item,
                ffprobe: mediainfo, 
                jacredInfo: {
                    audioList: audioTracks,
                    subList: subTracks,
                    videotype: (item.Title.toLowerCase().includes('hdr') || item.Title.toLowerCase().includes('dolby vision')) ? 'hdr' : 'sdr'
                }
            };
        });

    } catch (e) {
        console.error("Torrent API Error:", e.message);
        return [];
    }
}

module.exports = { searchTorrents };