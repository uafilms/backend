const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');
const { getLinksFromAshdiUrl } = require('./ashdi');

const API_HOST = 'https://api.uakino.app';
const CERT_FILE = path.join(__dirname, 'uakino-app.certs/cert.pem');
const KEY_FILE = path.join(__dirname, 'uakino-app.certs/cert.key');

const httpsAgent = new https.Agent({
    cert: fs.readFileSync(CERT_FILE),
    key: fs.readFileSync(KEY_FILE),
});

const API_CONFIG = {
    httpsAgent,
    headers: { 'User-Agent': 'ktor-client' },
    timeout: 120000,
};

const CACHE_DIR = path.join(__dirname, '../cache');
const DB_FILE = path.join(CACHE_DIR, 'uakino.db');
const DB_TTL = 24 * 60 * 60 * 1000;

function parseXfields(xf) {
    const m = {};
    (xf || '').split('||').forEach(p => {
        const i = p.indexOf('|');
        if (i > 0) m[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    return m;
}

function createDb() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS content (
            id          INTEGER PRIMARY KEY,
            title       TEXT,
            origname    TEXT,
            year        TEXT,
            imdb_all    TEXT,
            imdb_rating TEXT,
            kinopoisk_id TEXT,
            poster      TEXT,
            ashdivip    TEXT,
            playlist    TEXT,
            is_tv       INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_content_title    ON content(title);
        CREATE INDEX IF NOT EXISTS idx_content_origname ON content(origname);
    `);
    return db;
}

function isDbFresh() {
    if (!fs.existsSync(DB_FILE)) return false;
    return Date.now() - fs.statSync(DB_FILE).mtimeMs < DB_TTL;
}

let db = null;
const initPromise = (async () => {
    try {
        if (isDbFresh()) {
            db = createDb();
            const count = db.prepare('SELECT COUNT(*) as c FROM content').get().c;
            console.log('[UAKino] DB loaded:', count, 'items from', DB_FILE);
            return;
        }

        console.log('[UAKino] Fetching full catalog (limit=99999)...');
        const res = await axios.get(`${API_HOST}/api/v1/filter?limit=99999`, API_CONFIG);
        const items = res.data;
        if (!Array.isArray(items)) throw new Error('filter: not an array');

        db = createDb();
        db.prepare('DELETE FROM content').run();

        const insert = db.prepare(
            'INSERT INTO content (id, title, origname, year, imdb_all, imdb_rating, kinopoisk_id, poster, ashdivip, playlist, is_tv) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );

        const batch = db.transaction((rows) => {
            for (const item of rows) {
                const xf = parseXfields(item.xfields || '');
                const title = (item.title || '').trim();
                const origname = (xf.origname || '').trim();
                const isTV = !xf.ashdivip && xf.playlist ? 1 : 0;
                insert.run(
                    item.id, title, origname,
                    xf.year || '', xf.imdb_all || '', xf.imdb || '',
                    xf.kinopoisk_id || '', xf.poster || '',
                    xf.ashdivip || '', xf.playlist || '',
                    isTV
                );
            }
        });

        batch(items);
        console.log('[UAKino] DB built:', items.length, 'items');
    } catch (e) {
        console.error('[UAKino] Init error:', e.message);
        throw e;
    }
})();

function search(title, origTitle) {
    if (!db) return null;
    const nT = (title || '').trim().toLowerCase();
    const nO = (origTitle || '').trim().toLowerCase();
    if (!nT && !nO) return null;

    let stmt = db.prepare('SELECT * FROM content WHERE LOWER(title) = ? OR LOWER(origname) = ? OR LOWER(origname) = ?');
    let row = stmt.get(nT, nT, nO);
    if (row) return row;

    stmt = db.prepare('SELECT * FROM content WHERE LOWER(title) LIKE ? OR LOWER(origname) LIKE ?');
    row = stmt.get(`%${nT}%`, `%${nT}%`);
    if (row) return row;

    if (nO) {
        stmt = db.prepare('SELECT * FROM content WHERE LOWER(origname) LIKE ?');
        row = stmt.get(`%${nO}%`);
        if (row) return row;
    }

    const words = [...new Set(nT.split(/\s+/).filter(w => w.length > 2))];
    if (words.length) {
        stmt = db.prepare('SELECT * FROM content WHERE ' + words.map(() => '(LOWER(title) LIKE ? OR LOWER(origname) LIKE ?)').join(' OR '));
        const params = words.flatMap(w => [`%${w}%`, `%${w}%`]);
        row = stmt.get(...params);
        if (row) return row;
    }

    return null;
}

module.exports = {
    initPromise,
    getLinks: async (imdbId, title, originalTitle, year, host, signal) => {
        console.log('[UAKino] Searching for:', title);
        try {
            await initPromise;
            const row = search(title, originalTitle);
            if (!row) { console.log('[UAKino] Not found:', title); return null; }

            console.log('[UAKino] Matched:', row.title, '(id:', row.id, ')');

            // Try ashdivip first (direct VOD URL to ashdi.vip)
            if (row.ashdivip) {
                const url = row.ashdivip.startsWith('//') ? 'https:' + row.ashdivip : row.ashdivip;
                console.log('[UAKino] Ashdi URL:', url);
                const parsed = await getLinksFromAshdiUrl(url, title);
                if (parsed && parsed.length) return { _routes: { ashdi: parsed } };
            }

            // Try playlist (JSON array — flat {file,title} for movies, or nested {folder} for series)
            if (row.playlist) {
                try {
                    const cleaned = row.playlist.replace(/\\"/g, '"');
                    const pl = JSON.parse(cleaned);
                    const fixProto = obj => {
                        if (Array.isArray(obj)) obj.forEach(fixProto);
                        else if (obj && typeof obj === 'object') {
                            if (obj.file && obj.file.startsWith('//')) obj.file = 'https:' + obj.file;
                            if (obj.folder) fixProto(obj.folder);
                        }
                    };
                    fixProto(pl);
                    return pl;
                } catch (e) {
                    console.log('[UAKino] Bad playlist JSON:', e.message);
                }
            }

            console.log('[UAKino] No ashdivip or playlist for id:', row.id);
            return null;
        } catch (e) {
            console.error('[UAKino] getLinks error:', e.message);
            return null;
        }
    },
};
