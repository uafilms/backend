const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKENS_FILE = path.join(__dirname, '..', 'tokens.json');

function generateToken() {
    return 'sk_' + crypto.randomBytes(24).toString('hex');
}

const args = process.argv.slice(2);
const count = parseInt(args[0]) || 1;

try {
    let tokens = [];
    if (fs.existsSync(TOKENS_FILE)) {
        try {
            const content = fs.readFileSync(TOKENS_FILE, 'utf8');
            tokens = JSON.parse(content);
            if (!Array.isArray(tokens)) tokens = [];
        } catch (e) {
            tokens = [];
        }
    }

    const newTokens = [];
    for (let i = 0; i < count; i++) {
        const t = generateToken();
        tokens.push(t);
        newTokens.push(t);
    }

    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');

    console.log(`✅ Згенеровано ${count} токенів.`);
    console.log(`📁 Файл: ${TOKENS_FILE}`);
    console.log('🔑 Нові ключі:');
    newTokens.forEach(t => console.log(t));

} catch (error) {
    console.error('❌ Помилка:', error.message);
}