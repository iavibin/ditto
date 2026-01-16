# Ditto Media Forwarder 🚀

A modular, stateless Discord bot designed to forward Images, Videos, and Audio files from multiple source channels to a single target gallery channel.

## ✨ Features

-   **Multi-Format Support**: Automatically detects and forwards Images, Videos, and Audio.
-   **Stateless & Fast**: Does not use a database. It processes messages instantly and forgets them, keeping memory usage minimal.
-   **Automatic Embed Handling**: Forwards not just uploaded files, but also media links (like Imgur) that Discord turns into embeds.
-   **Header Metadata**: Each forwarded message includes protected headers showing the original author and source channel.
-   **Robust Reliability**: Configured with a 60-second request timeout to ensure large high-quality videos upload successfully.

---

## 🛠️ Setup

### 1. Prerequisites
-   [Node.js](https://nodejs.org/) (v20 or higher recommended)
-   Discord Bot Token ([Discord Developer Portal](https://discord.com/developers/applications))
-   **Message Content Intent** enabled in the Discord Developer Portal.

### 2. Installation
```powershell
npm install
```

### 3. Configuration
Create a `.env` file in the root directory:
```env
DISCORD_TOKEN=your_token_here
SOURCE_CHANNELS=id1,id2,id3
TARGET_CHANNEL=target_id_here
PORT=3000
```

---

## 🚀 Running the Bot

### Development Mode (with auto-reload)
```powershell
npm run dev
```

### Production Mode (Compiled JS)
```powershell
npm run build
npm start
```

---

## 📦 Project Structure

-   `src/index.ts`: The entry point (Manager). Handles client initialization and health checks.
-   `src/events/messageCreate.ts`: The event handler (Muscle). Controls the forwarding logic.
-   `src/utils/media.ts`: The utility module (Eyes). Handles media detection and name guessing.
-   `dist/`: The compiled JavaScript folder used for deployment.

---

## ☁️ Deployment (Render)

1.  **Build Command**: `npm install && npm run build`
2.  **Start Command**: `npm start`
3.  **Environment Variables**: Add `DISCORD_TOKEN`, `SOURCE_CHANNELS`, and `TARGET_CHANNEL` in the Render dashboard.

---

## 📄 License
ISC
