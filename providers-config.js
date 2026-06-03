module.exports = {
  get turnstile() {
    return {
      enabled: process.env.TURNSTILE_ENABLED === 'true',
      siteKey: process.env.TURNSTILE_SITE_KEY || '',
    };
  },

  providers: {
    ashdi:    { ping: 1509, sources: ['wormhole', 'uatut', 'klon', 'uakino-app', 'uakino-best', 'kinoukr', 'kinoukr-db', 'uaflix'] },
    tortuga:  { ping: 2207, sources: ['uaserials-com', 'kinoukr', 'kinoukr-db'] },
    hdvb:     { ping: 1072, sources: ['eneyida', 'uaserials-my'] },
    moonanime:{ ping: null, sources: ['moonanime'] },
    uaflix:   { ping: 1772, sources: ['uaflix'] },
    uembed:   { ping: null, sources: ['uembed'] },
  },
};
