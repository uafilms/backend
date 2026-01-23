const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Шлях до .env файлу в корені проекту
const ENV_FILE = path.join(__dirname, '..', '.env');

function generateToken() {
    return 'sk_' + crypto.randomBytes(24).toString('hex');
}

const args = process.argv.slice(2);
const count = parseInt(args[0]) || 1;

try {
    let envContent = '';
    if (fs.existsSync(ENV_FILE)) {
        envContent = fs.readFileSync(ENV_FILE, 'utf8');
    }

    // Генеруємо нові токени
    const newTokens = [];
    for (let i = 0; i < count; i++) {
        newTokens.push(generateToken());
    }

    // Шукаємо існуючу змінну API_TOKENS
    const lines = envContent.split('\n');
    let tokensIndex = lines.findIndex(line => line.startsWith('API_TOKENS='));

    if (tokensIndex !== -1) {
        // Якщо змінна вже є, додаємо нові токени до існуючих через кому
        const existingTokens = lines[tokensIndex].split('=')[1].trim();
        const updatedTokens = existingTokens ? `${existingTokens},${newTokens.join(',')}` : newTokens.join(',');
        lines[tokensIndex] = `API_TOKENS=${updatedTokens}`;
    } else {
        // Якщо змінної немає, додаємо новий рядок
        lines.push(`API_TOKENS=${newTokens.join(',')}`);
    }

    // Записуємо оновлений контент назад у .env
    fs.writeFileSync(ENV_FILE, lines.join('\n').trim() + '\n', 'utf8');

    console.log(`✅ Згенеровано та додано у .env: ${count} токенів.`);
    console.log('🔑 Нові ключі:');
    newTokens.forEach(t => console.log(t));
    console.log('\n💡 Не забудьте додати ці токени в Settings > Environment Variables на Vercel!');

} catch (error) {
    console.error('❌ Помилка:', error.message);
}