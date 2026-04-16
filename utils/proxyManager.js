const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

const proxyUrls = process.env.PROXIES ? process.env.PROXIES.split(',').map(s => s.trim()).filter(Boolean) : [];
const agents = proxyUrls.map(url => {
    try {
        return url.startsWith('socks') ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
    } catch (e) {
        console.error(`Invalid proxy URL: ${url}`);
        return null;
    }
}).filter(a => a !== null);

// Provider whitelist via env: PROXIED_PROVIDERS=ashdi,hdvb,uafilms-me
// Special value "*" enables proxy for all providers.
// If var is not set, falls back to the legacy default for backward compatibility.
const rawList = (process.env.PROXIED_PROVIDERS ?? 'ashdi,tortuga,uaflix')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
const PROXY_ALL = rawList.includes('*');
const enabledSet = new Set(rawList);

let counter = 0;
module.exports = {
    getConfig: (providerName) => {
        if (agents.length === 0) return {};
        const name = String(providerName || '').toLowerCase();
        if (!PROXY_ALL && !enabledSet.has(name)) return {};
        const agent = agents[counter % agents.length];
        counter++;
        return { httpsAgent: agent, httpAgent: agent, proxy: false };
    }
};
