const axios = require('axios');
const proxyManager = require('../utils/proxyManager');
const tmdb = require('../tmdb');

const PROXY = 'https://ashdi.aartzz.pp.ua';
const FALLBACK = 'http://194.246.82.144/ukr';

const fix = s => typeof s === 'string' ? s.replace(/0yql3tj/g, "oyql3tj") : s;

async function getIframeViaProxy(kpId, axiosConfig) {
  try {
    const r = await axios.get(`${PROXY}/api/product/read_api.php?kinopoisk=${kpId}`, axiosConfig);
    return r.data.match(/src=["']([^"']+)["']/i)?.[1] || null;
  } catch {
    return null;
  }
}

async function getIframeViaFallback(title, year, axiosConfig) {
  try {
    const r = await axios.get(`${FALLBACK}?eng_name=${encodeURIComponent(title)}`, axiosConfig);
    if (!Array.isArray(r.data)) return null;
    const match = r.data.find(i => i.year == year && i.ashdi);
    return match?.ashdi || null;
  } catch {
    return null;
  }
}

function parsePlayer(html, title) {
  // source tags (фільм)
  const sources = [...html.matchAll(/<source[^>]+src=["']([^"']+\.m3u8[^"']*)["'][^>]*>/gi)]
    .map(m => ({ file: fix(m[1]), quality: m[0].match(/label=["']([^"']+)/i)?.[1] || 'Auto' }));

  if (sources.length)
    return sources.map(s => ({ file: s.file, title, quality: s.quality }));

  // file:
  const raw = html.match(/file\s*:\s*['"]([^'"]+)['"]/)?.[1];
  if (!raw) return null;

  // серіал
  if (raw.trim().startsWith('[')) {
    const arr = JSON.parse(raw);
    const walk = items => items.map(i => ({
      ...i,
      file: i.file ? fix(i.file) : undefined,
      folder: i.folder ? walk(i.folder) : undefined
    }));
    return walk(arr);
  }

  // фільм
  return [{ file: fix(raw), title, quality: 'Auto' }];
}

module.exports = {
  getLinks: async (kpId, title, year) => {
    const axiosConfig = proxyManager.getConfig('ashdi');
    try {
      let iframe =
        (kpId && await getIframeViaProxy(kpId, axiosConfig)) ||
        await getIframeViaFallback(title, year, axiosConfig);

      if (!iframe) return null;

      const html = (await axios.get(iframe.replace('https://ashdi.vip', PROXY), axiosConfig)).data;
      return parsePlayer(html, title);
    } catch {
      return null;
    }
  },

  getStream: async (id, type, season, episode) => {
    try {
      const info = await tmdb.details(type, id);
      const extIds = await tmdb.getExternalIds(id, type === 'tv');
      const kpId = extIds?.kinopoisk_id;
      const title = info.original_title || info.original_name;
      const year = (info.release_date || info.first_air_date || "").split("-")[0];

      const links = await module.exports.getLinks(kpId, title, year);
      if (!links) return null;

      if (type === 'movie') {
        const src = Array.isArray(links) ? links[0] : links;
        return src?.file ? { url: src.file, type: 'application/x-mpegURL' } : null;
      }

      let found = null;
      const walk = (items, sCtx) => {
        for (const it of items) {
          let s = sCtx, e = null;
          const t = it.title || '';
          const sm = t.match(/(\d+)\s*(?:season|сезон)|(?:season|сезон)\s*(\d+)/i);
          if (sm) s = parseInt(sm[1] || sm[2]);
          const em = t.match(/(\d+)\s*(?:episode|серія)|(?:ep|e)\s*(\d+)/i);
          if (em) e = parseInt(em[1] || em[2]);

          if (it.folder) walk(it.folder, s);
          else if (it.file && s == season && e == episode) {
            found = it.file;
            return;
          }
        }
      };

      if (Array.isArray(links)) walk(links, null);
      return found ? { url: found, type: 'application/x-mpegURL' } : null;

    } catch (e) {
      console.error("Ashdi getStream error:", e);
      return null;
    }
  }
};
