const axios = require('axios');
const proxyManager = require('../utils/proxyManager');

/**
 * Parse HDVB iframe content to extract file URL(s), poster, subtitle.
 * Handles both simple file URLs and complex nested JSON arrays (for TV series).
 * Used by any site that embeds HDVB players (eneyida.tv, uaserials.my, etc.)
 */
async function parseHdvbIframe(iframeSrc, referer) {
    const axiosConfig = proxyManager.getConfig('hdvb');
    try {
        const { data: html } = await axios.get(iframeSrc, {
            headers: { 'Referer': referer || '' },
            ...axiosConfig,
            timeout: 15000
        });
        if (!html || typeof html !== 'string') return null;

        // Match file value - could be JSON array/object (with or without quotes), or a URL
        // New HDVB format: file: [{...}]  (no quotes)
        // Old format: file: '[{...}]' or file: 'https://...'
        
        // Find the file: keyword position
        const filePos = html.search(/file\s*:\s*/);
        if (filePos === -1) return null;
        
        // Get content after file:
        const afterFile = html.substring(filePos + html.match(/file\s*:\s*/)[0].length);
        let fileValue = null;
        
        if (afterFile.startsWith('[') || afterFile.startsWith('{')) {
            // JSON structure - use bracket counting
            const openChar = afterFile[0];
            const closeChar = openChar === '[' ? ']' : '}';
            let depth = 0;
            let inString = false;
            let escaped = false;
            
            for (let i = 0; i < afterFile.length; i++) {
                const ch = afterFile[i];
                if (escaped) { escaped = false; continue; }
                if (ch === '\\') { escaped = true; continue; }
                if (ch === '"' && !escaped) { inString = !inString; continue; }
                if (!inString) {
                    if (ch === openChar) depth++;
                    if (ch === closeChar) {
                        depth--;
                        if (depth === 0) {
                            fileValue = afterFile.substring(0, i + 1);
                            break;
                        }
                    }
                }
            }
        } else if (afterFile.startsWith("'") || afterFile.startsWith('"')) {
            // Quoted string
            const quote = afterFile[0];
            const endQuote = afterFile.indexOf(quote, 1);
            if (endQuote > 0) fileValue = afterFile.substring(1, endQuote);
        }
        
        if (!fileValue) return null;

        // Try to parse as JSON
        if (fileValue.startsWith('[') || fileValue.startsWith('{')) {
            const openChar = fileValue[0];
            const closeChar = openChar === '[' ? ']' : '}';
            let depth = 0;
            let inString = false;
            let escaped = false;

            for (let i = 0; i < fileValue.length; i++) {
                const ch = fileValue[i];
                if (escaped) { escaped = false; continue; }
                if (ch === '\\') { escaped = true; continue; }
                if (ch === '"' && !escaped) { inString = !inString; continue; }
                if (!inString) {
                    if (ch === openChar) depth++;
                    if (ch === closeChar) {
                        depth--;
                        if (depth === 0) {
                            fileValue = fileValue.substring(0, i + 1);
                            break;
                        }
                    }
                }
            }

            try {
                const parsed = JSON.parse(fileValue);
                // Filter out invalid items
                const valid = Array.isArray(parsed)
                    ? parsed.filter(item => item && (item.file || item.folder))
                    : (parsed.file || parsed.folder ? parsed : null);
                return valid;
            } catch { /* fall through */ }
        }

        // Simple URL
        if (fileValue && fileValue.startsWith('http')) {
            const getParam = (p) => (html.match(new RegExp(`${p}:\\s?['"]([^'"]+)['"]`)) || [])[1] || null;
            return {
                file: fileValue,
                poster: getParam('poster'),
                subtitle: getParam('subtitle')
            };
        }

        return null;
    } catch (e) {
        console.error('[HDVB] parseHdvbIframe error:', e.message);
        return null;
    }
}

module.exports = { parseHdvbIframe };
