# 🎬 UAFilms - Backend

**UAFilms** is a aggregator of movies and TV series that combines content from multiple sources (providers) and provides a convenient interface for searching and viewing.

> [!WARNING]  
> This project is currently in **Beta**. Some features may be unstable, and content availability depends on third-party sources.

---

## 🚀 Features

* **Multi-Provider Support**: Aggregates content from popular providers including **Ashdi**, **Tortuga**, **HDVB**, **MoonAnime**, and **UAFlix**.
* **Intelligent Metadata**: Deep integration with **TMDB** and **IMDb** for posters, ratings, and detailed film information.
* **Security First**: Integrated **Cloudflare Turnstile** protection and a custom API key (token) system to prevent unauthorized access.
* **Performance Optimized**: Uses `node-cache` for high-speed metadata retrieval and playlist processing.
* **Advanced M3U8 Parsing**: A custom parser that handles nested playlists and converts segments into absolute paths for better compatibility.
* **Proxy Management**: Built-in support for SOCKS and HTTPS proxies to bypass regional restrictions.

---

## 🛠 Tech Stack

* **Runtime**: Node.js
* **Framework**: Express
* **Scraping & API**: Axios, Cheerio
* **Player UI**: Video.js with Material You (M3) custom styling
* **Deployment**: Ready for Vercel or any Linux-based server using `systemctl`.

---

## 📦 Installation & Setup

### 1. Clone the repository

```bash
git clone https://github.com/your-username/uafilms-backend.git
cd uafilms-backend

```

### 2. Install dependencies

```bash
npm install

```

### 3. Environment Configuration

Copy `.env.example` to `.env` file in the root directory and add your credentials:

```env
PORT=3000
TMDB_TOKEN=your_tmdb_bearer_token
TURNSTILE_ENABLED=true
TURNSTILE_SECRET_KEY=your_cloudflare_secret
# Optional: Proxy settings
PROXY_URLS=socks5://user:pass@host:port

```

### 4. Run the server

```bash
npm start

```

---

## 🔌 API Endpoints (Quick Reference)

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/details` | `GET` | Get detailed movie/series info from TMDB |
| `/api/get` | `GET` | Retrieve streaming links from all providers |
| `/api/comments` | `GET` | Fetch user comments from integrated sources |

> [!NOTE]  
> For more endpoints and detailed documentation, refer to the [API Documentation](https://bfilms.aartzz.pp.ua/).

---

## 🛡 Security

The backend includes a token management script to generate bypass keys:

```bash
node scripts/token.js

```

This will create a `tokens.json` file. Use these tokens in the `x-api-key` header to bypass CAPTCHA requirements.

---

## 📄 License

This project is licensed under the **Apache License 2.0**. See the [LICENSE](https://www.google.com/search?q=LICENSE) file for details.