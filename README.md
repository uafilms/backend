# 🎬 UAFilms - Backend

[🇬🇧 English](./README-en.md)

![Docker Build Status](https://img.shields.io/github/actions/workflow/status/uafilms/backend/docker-publish.yml?branch=main&label=docker%20build&logo=docker)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/uafilms/backend)

> [!WARNING]  
> проект досі у бета-тесті, тому пишіть всі баги які бачили у [Issues](https://github.com/uafilms/backend/issues) або в [Телеграм-чат](https://t.me/uafilms_official)

---

## що це за штука?
це агрегатор який шукає фільми/серіали по українським джерелам і віддає прямі посилання на стріми.

---

## встановлення і запуск
### 🐳Docker (рекомендовано, одною командою)
1. переназвіть `.env.example` у `.env` і впишіть усі потрібні значення _(`PORT` не міняти)_
2. запустіть команду: _(замініть `<port>` на порт, на якому ви хочете запустити цей сервіс)_
```bash
docker run --name uafilms-backend -p <port>:3000 --env-file .env  --restart unless-stopped aartzz/uafilms-backend:latest
```

### 🛠Вручну
1. клонуйте репозиторій
```bash
git clone https://github.com/uafilms/backend.git
cd backend
```
2. переназвіть `.env.example` у `.env` і впишіть усі потрібні значення
3. встановіть залежності `npm install` і запустіть `node index.js`

---

## Джерела

| VOD провайдер | Сайт | Сайтів, що парсять | Мова |
|---|---|---|---|
| Ashdi | [ashdi.vip](https://ashdi.vip) | 5 | 🇺🇦 |
| HDVB (Eneyida, UA Serials) | [eneyida.tv](https://eneyida.tv) | 2 | 🇺🇦 |
| Tortuga | [tortuga.tw](https://tortuga.tw) | 2 | 🇺🇦 |
| UAFlix | [uafix.net](https://uafix.net) | 1 | 🇺🇦 |
| MoonAnime | [moonanime.art](https://moonanime.art) | 1 | 🇺🇦 |
| UEmbed | [cinepro.aartzz.pp.ua](https://cinepro.aartzz.pp.ua) | 1 | 🇬🇧 |

---

## Документація
ви можете дізнатися всі доступні роути у [цій документації](https://bfilms.aartzz.pp.ua/) або піти глибше і запитати у [DeepWiki](https://deepwiki.com/uafilms/backend)