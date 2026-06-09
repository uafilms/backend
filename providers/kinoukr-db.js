// KinoUkr DB — downloads kinoukr.json from lampac repo, converts to SQLite for fast lookups
// Returns ashdi + tortuga routes (same interface as kinoukr.js)

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getLinksFromAshdiUrl } = require('./ashdi');
const { parseTortugaVod, parseTortugaEmbed } = require('./tortuga');

const JSON_URL = 'https://raw.githubusercontent.com/lampac-nextgen/lampac/refs/heads/main/Core/data/kinoukr.json';
const CACHE_DIR = path.join(__dirname, '../cache');
const DB_FILE = path.join(CACHE_DIR, 'kinoukr.db');
const DB_TTL = 24 * 60 * 60 * 1000;

const ASHDI_BASE = 'https://ashdi.vip';
const TORTUGA_BASE = 'https://tortuga.tw';

function createDb() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS content (
            slug         TEXT PRIMARY KEY,
            title        TEXT,
            eng_name     TEXT,
            search_title TEXT,
            search_eng   TEXT,
            year         TEXT,
            kp_id        TEXT,
            imdb_id      TEXT,
            ashdi_path   TEXT,
            tortuga_path TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_kinoukr_search_title ON content(search_title);
        CREATE INDEX IF NOT EXISTS idx_kinoukr_search_eng   ON content(search_eng);
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
            console.log('[KinoUkrDB] DB loaded:', count, 'items from', DB_FILE);
            return;
        }

        console.log('[KinoUkrDB] Fetching kinoukr.json...');
        const res = await axios.get(JSON_URL, { timeout: 60000 });
        const data = res.data;
        if (!data || typeof data !== 'object') throw new Error('Invalid JSON response — expected object');

        db = createDb();

        const insert = db.prepare(
            `INSERT OR REPLACE INTO content (slug, title, eng_name, search_title, search_eng, year, kp_id, imdb_id, ashdi_path, tortuga_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        const batch = db.transaction((entries) => {
            for (const [slug, item] of Object.entries(entries)) {
                const title = (item.name || '').trim();
                const engName = (item.eng_name || '').trim();
                insert.run(
                    slug,
                    title,
                    engName,
                    norm(title.toLowerCase()),
                    norm(engName.toLowerCase()),
                    item.year || '',
                    item.kp_id || '',
                    item.imdb_id || '',
                    item.ashdi || '',
                    item.tortuga || ''
                );
            }
        });

        batch(data);
        console.log('[KinoUkrDB] DB built:', Object.keys(data).length, 'items');
    } catch (e) {
        console.error('[KinoUkrDB] Init error:', e.message);
        // Don't throw — allow degraded operation (search returns null)
    }
})();

// Normalize Cyrillic for fuzzy matching: ґ→г, ї→ї, є→е, і→и (already in lowercase)
function norm(s) {
    return (s || '').replace(/ґ/g, 'г').replace(/ї/g, 'ї').replace(/є/g, 'е');
}

function search(title, engName) {
    if (!db) return null;
    const nT = norm((title || '').trim().toLowerCase());
    const nE = norm((engName || '').trim().toLowerCase());
    if (!nT && !nE) return null;

    // Exact match by search_title or search_eng (pre-lowercased for Unicode support)
    let row = db.prepare('SELECT * FROM content WHERE search_title = ? OR search_eng = ?').get(nT, nT);
    if (row) return row;

    // Exact match by search_eng (if different from title)
    if (nE && nE !== nT) {
        row = db.prepare('SELECT * FROM content WHERE search_eng = ?').get(nE);
        if (row) return row;
    }

    // LIKE match using pre-lowercased columns
    row = db.prepare('SELECT * FROM content WHERE search_title LIKE ? OR search_eng LIKE ?').get(`%${nT}%`, `%${nT}%`);
    if (row) return row;

    if (nE) {
        row = db.prepare('SELECT * FROM content WHERE search_eng LIKE ?').get(`%${nE}%`);
        if (row) return row;
    }

    // Word-by-word
    const words = [...new Set(nT.split(/\s+/).filter(w => w.length > 2))];
    if (words.length) {
        const where = words.map(() => '(search_title LIKE ? OR search_eng LIKE ?)').join(' OR ');
        row = db.prepare(`SELECT * FROM content WHERE ${where}`).get(...words.flatMap(w => [`%${w}%`, `%${w}%`]));
        if (row) return row;
    }

    return null;
}

module.exports = {
    initPromise,

    getLinks: async (imdbId, title, originalTitle, year, signal) => {
        console.log('[KinoUkrDB] Searching for:', title);
        try {
            await initPromise;
            if (!db) {
                console.log('[KinoUkrDB] DB not available');
                return null;
            }

            // Prefer imdb_id match
            let row = null;
            if (imdbId && /^tt\d+$/i.test(imdbId)) {
                row = db.prepare('SELECT * FROM content WHERE imdb_id = ?').get(imdbId);
            }

            if (!row) {
                row = search(title, originalTitle);
            }

            if (!row) {
                console.log('[KinoUkrDB] Not found:', title);
                return null;
            }

            console.log('[KinoUkrDB] Matched:', row.title, `(${row.eng_name})`);

            const routes = {};
            const fetches = [];

            // ── Ashdi ────────────────────────────────────────────────────────
            if (row.ashdi_path) {
                const ashdiUrl = `${ASHDI_BASE}/${row.ashdi_path}`;
                console.log('[KinoUkrDB] Ashdi URL:', ashdiUrl);
                fetches.push(
                    getLinksFromAshdiUrl(ashdiUrl, title || row.title)
                        .then(parsed => {
                            if (parsed && Array.isArray(parsed) && parsed.length) {
                                routes.ashdi = parsed;
                            }
                        })
                        .catch(e => console.error('[KinoUkrDB] Ashdi error:', e.message))
                );
            }

            // ── Tortuga ──────────────────────────────────────────────────────
            if (row.tortuga_path) {
                const tortugaUrl = `${TORTUGA_BASE}/${row.tortuga_path}`;
                console.log('[KinoUkrDB] Tortuga URL:', tortugaUrl);
                fetches.push(
                    (row.tortuga_path.startsWith('embed/')
                        ? parseTortugaEmbed(tortugaUrl)
                        : parseTortugaVod(tortugaUrl)
                    ).then(result => {
                        if (row.tortuga_path.startsWith('embed/') && result && result.length) {
                            routes.tortuga = result.map(season => ({
                                ...season,
                                folder: (season.folder || []).map(ep => ({
                                    ...ep,
                                    folder: (ep.folder || []).map(dub => ({
                                        ...dub,
                                        poster: dub.poster || null,
                                    })),
                                })),
                            }));
                        } else if (!row.tortuga_path.startsWith('embed/') && result && result.file) {
                            routes.tortuga = [{
                                title: row.title || 'Tortuga',
                                file: result.file,
                                poster: result.poster || null,
                            }];
                        }
                    }).catch(e => console.error('[KinoUkrDB] Tortuga error:', e.message))
                );
            }

            // Don't wait more than 3s — Tortuga finishes in <1s, Ashdi takes 15s
            await Promise.race([
                Promise.allSettled(fetches),
                new Promise(r => setTimeout(r, 3000)),
            ]);

            if (!Object.keys(routes).length) return null;
            return { _routes: routes };
        } catch (e) {
            console.error('[KinoUkrDB] getLinks error:', e.message);
            return null;
        }
    },
};
