const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

const proxyUrls = process.env.PROXIES ? process.env.PROXIES.split(',') : [];
const agents = proxyUrls.map(url => {
    try {
        return url.startsWith('socks') ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
    } catch (e) {
        console.error(`Invalid proxy URL: ${url}`);
        return null;
    }
}).filter(a => a !== null);

let counter = 0;
const PROXY_CONFIG = {
    enabledFor: ['ashdi', 'tortuga', 'uaflix'] // додайте потрібні
};

module.exports = {
    getConfig: (providerName) => {
        if (agents.length > 0 && PROXY_CONFIG.enabledFor.includes(providerName)) {
            // Ротація: вибираємо наступний проксі зі списку
            const agent = agents[counter % agents.length];
            counter++;
            return { httpsAgent: agent, httpAgent: agent, proxy: false };
        }
        return {};
    }
};