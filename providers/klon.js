// Site: klon.fun → Provider: Ashdi

const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('../utils/proxyManager');
const { getLinksFromAshdiUrl, absoluteUrl, cleanTitle, extractYearFromText, NAV_HEADERS, BASE_HEADERS } = require('./ashdi');

const BASE_URL = 'https://klon.fun';
const SEARCH_URL = `${BASE_URL}/engine/ajax/controller.php?mod=search`;

async function fetchUserHash(axiosConfig) {
    const { data: html } = await axios.get(BASE_URL + '/', {
        ...axiosConfig,
        headers: { ...NAV_HEADERS, 'Referer': BASE_URL + '/' },
        timeout: 15000
    });
    const hash = html.match(/(?:dle_login_hash|user_hash)\s*=\s*'([^']+)'/)?.[1] ||
                 html.match(/name="user_hash"\s+value="([^"]+)"/)?.[1];
    return hash || null;
}

async function searchTitle(query, axiosConfig) {
    const userHash = await fetchUserHash(axiosConfig);
    if (!userHash) return [];
    const form = new URLSearchParams({ query, skin: 'klontv', user_hash: userHash });
    const { data: html } = await axios.post(SEARCH_URL, form.toString(), {
        ...axiosConfig,
        headers: {
            ...NAV_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest', 'Origin': BASE_URL, 'Referer': BASE_URL + '/'
        },
        timeout: 15000
    });
    const $ = cheerio.load(html);
    const results = [];
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || !/\.html(?:\?|$)/i.test(href) || /do=search|subaction=search|mode=advanced/i.test(href)) return;
        const title = $(el).find('.searchheading').text().trim() || $(el).text().trim();
        if (!title) return;
        results.push({ title, url: absoluteUrl(href, BASE_URL) });
    });
    const uniq = new Map();
    for (const item of results) if (!uniq.has(item.url)) uniq.set(item.url, item);
    return [...uniq.values()];
}

function scoreResult(item, fallbackTitle, year, imdbId) {
    let score = 0;
    const itemTitle = cleanTitle(item.title);
    const targetTitle = cleanTitle(fallbackTitle);
    const itemYear = extractYearFromText(item.title) || extractYearFromText(item.url);
    if (imdbId && /^tt\d+$/i.test(imdbId)) score += 100;
    if (targetTitle && itemTitle === targetTitle) score += 80;
    else if (targetTitle && itemTitle.includes(targetTitle)) score += 45;
    else if (targetTitle) {
        const targetWords = targetTitle.split(' ').filter(Boolean);
        score += targetWords.filter(w => itemTitle.includes(w)).length * 6;
    }
    if (year && itemYear && Number(year) === Number(itemYear)) score += 35;
    if (/\/serialy\//i.test(item.url)) score += 3;
    if (/\/filmy\//i.test(item.url)) score += 3;
    if (/\/multfilmy\//i.test(item.url)) score += 3;
    return score;
}

async function findBestPostUrl(imdbId, fallbackTitle, year, axiosConfig) {
    const query = (imdbId && /^tt\d+$/i.test(imdbId)) ? imdbId.trim() : (fallbackTitle || '').trim();
    if (!query) return null;
    const results = await searchTitle(query, axiosConfig);
    if (!results.length) return null;
    results.sort((a, b) => scoreResult(b, fallbackTitle, year, imdbId) - scoreResult(a, fallbackTitle, year, imdbId));
    return results[0]?.url || null;
}

async function getIframe(postUrl, axiosConfig) {
    try {
        const { data: html } = await axios.get(postUrl, {
            ...axiosConfig,
            headers: { ...NAV_HEADERS, 'Referer': BASE_URL + '/' },
            timeout: 15000
        });
        const $ = cheerio.load(html);
        let src = $('iframe[data-src*="ashdi.vip"]').attr('data-src') ||
                  $('iframe[src*="ashdi.vip"]').attr('src') ||
                  $('iframe[data-src*="ashdi"]').attr('data-src') ||
                  $('iframe[src*="ashdi"]').attr('src') ||
                  $('iframe[data-src]').attr('data-src') ||
                  $('iframe[src]').attr('src');
        if (!src) return null;
        src = absoluteUrl(src, postUrl);
        if (/\/vod\/\d+/i.test(src) && !src.includes('multivoice')) {
            src += (src.includes('?') ? '&' : '?') + 'multivoice';
        }
        return src;
    } catch (e) {
        console.error('[Klon] getIframe error:', e.message);
        return null;
    }
}

module.exports = {
    getLinks: async (imdbId, title, year) => {
        const axiosConfig = proxyManager.getConfig('klon');
        try {
            const postUrl = await findBestPostUrl(imdbId, title, year, axiosConfig);
            if (!postUrl) return null;
            const iframe = await getIframe(postUrl, axiosConfig);
            if (!iframe) return null;
            const html = (await axios.get(iframe, {
                ...axiosConfig,
                headers: { 'User-Agent': BASE_HEADERS['User-Agent'] },
                timeout: 15000
            })).data;
            const parsed = require('./ashdi').parsePlayer(html, title);
            if (!parsed || !parsed.length) return null;
            return { _routes: { ashdi: parsed } };
        } catch (e) {
            console.error('[Klon] getLinks error:', e.message);
            return null;
        }
    }
};
