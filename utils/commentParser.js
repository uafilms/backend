const cheerio = require('cheerio');

function parseUaKinoComments(htmlContent) {
    if (!htmlContent) return [];

    const $ = cheerio.load(htmlContent);
    
    const parseList = ($container) => {
        const items = [];

        $container.children('li.comments-tree-item').each((i, el) => {
            const $el = $(el);
            
            // ID
            const fullId = $el.attr('id') || '';
            const commentId = fullId.replace('comments-tree-item-', '');
            
            // Meta
            const $top = $el.find('.comm-top').first();
            const authorEl = $top.find('.comm-author a');
            const authorName = authorEl.length ? authorEl.text().trim() : $top.find('.comm-author').text().trim();
            const group = $top.find('.comm-group').text().trim();
            
            let avatar = $top.find('.comm-av img').attr('src');
            if (avatar) {
                if (avatar.startsWith('//')) avatar = 'https:' + avatar;
                else if (avatar.startsWith('/')) avatar = 'https://uakino.best' + avatar;
            }

            const rating = parseInt($top.find('.comm-rate span').text().trim()) || 0;

            // --- ОБРОБКА ТЕКСТУ ---
            const $body = $el.find('.comm-body').first();
            const $textContainer = $body.find('.comm-text');

            // 1. Розгортаємо вкладений div з ID (якщо є)
            const $innerDiv = $textContainer.find(`div[id^='comm-id-']`);
            if ($innerDiv.length > 0) {
                $innerDiv.replaceWith($innerDiv.contents());
            }

            // 2. Замінюємо <br> на переноси рядків \n
            $textContainer.find('br').replaceWith('\n');

            // 3. Отримуємо чистий текст (вже з переносами)
            const textContent = $textContainer.text()?.trim();

            // Дата
            const $dateContainer = $el.find('.comm-bottom .comm-date').first();
            const dateStr = $dateContainer.clone().children().remove().end().text().trim();

            // Рекурсія
            const $childrenList = $el.children('ol.comments-tree-list');
            const replies = $childrenList.length > 0 ? parseList($childrenList) : [];

            items.push({
                id: commentId,
                author: {
                    name: authorName,
                    avatar: avatar,
                    group: group
                },
                text: textContent, // Тепер просто text
                date: dateStr,
                rating: rating,
                replies: replies
            });
        });

        return items;
    };

    const $rootList = $('ol.comments-tree-list').first();
    return parseList($rootList);
}

module.exports = { parseUaKinoComments };