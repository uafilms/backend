function extractParam(html, param) {
    const regex = new RegExp(`${param}:\\s?["']([^"']+)["']`, 'i');
    const match = html.match(regex);
    return match ? match[1] : null;
}

module.exports = {
    decodeTortuga: (encoded) => {
        try {
            if (!encoded) return null;
            let clean = encoded.replace(/==$/, "");
            let decoded = Buffer.from(clean, 'base64').toString('utf-8');
            return decoded.split('').reverse().join('');
        } catch (e) { return encoded; }
    },
    extractMetadata: (html) => ({
        file: extractParam(html, 'file'),
        poster: extractParam(html, 'poster'),
        subtitle: extractParam(html, 'subtitle'),
        skip: extractParam(html, 'skip'),
        thumbnails: extractParam(html, 'thumbnails'),
        title: extractParam(html, 'title')
    })
};