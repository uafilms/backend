# 🎬 UAFilms – Backend

[🇺🇦 Українською](./README.md)

![Docker Build Status](https://img.shields.io/github/actions/workflow/status/uafilms/backend/docker-publish.yml?branch=main&label=docker%20build&logo=docker)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/uafilms/backend)

> [!WARNING]  
> This project is still in beta, so please report any bugs you find in the [Issues](https://github.com/uafilms/backend/issues) section or in the [Telegram chat](https://t.me/uafilms_official).

---

## What is this?
This is an aggregator that searches for movies and TV shows across ukrainan sources and returns direct stream links.

---

## Installation & Running

### 🐳 Docker (recommended, one command)
1. Rename `.env.example` to `.env` and fill in all required values _(do not change `PORT`)_
2. Run the command _(replace `<port>` with the port you want to use)_:
```bash
docker run --name uafilms-backend -p <port>:3000 --env-file .env --restart unless-stopped aartzz/uafilms-backend:latest
````

### 🛠 Manual

1. Clone the repository

```bash
git clone https://github.com/uafilms/backend.git
cd backend
```

2. Rename `.env.example` to `.env` and fill in all required values
3. Install dependencies with `npm install` and start the app using `node index.js`

---

## Sources
Ashdi, HDVB (Eneyida), UAFlix, MoonAnime, 🇬🇧UEmbed

---

## Documentation

You can find all available routes in the [documentation](https://bfilms.aartzz.pp.ua/), or go deeper by asking [DeepWiki](https://deepwiki.com/uafilms/backend).