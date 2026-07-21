# NovaTube Downloader

A premium, production-ready YouTube downloader web application built with Node.js, Express.js, vanilla JavaScript, FFmpeg, and yt-dlp-style workflows.

## Features

- Premium landing page with glassmorphism UI
- URL validation for YouTube links
- Video and audio analysis with metadata display
- Video and audio download queueing
- Trimming support via FFmpeg
- Local download history with LocalStorage
- Dark/light theme persistence
- Security middleware and input validation
- Automatic cleanup and safe temp handling

## Installation

1. Install dependencies:
   `npm install`
2. Copy the environment template:
   `cp .env.example .env`
3. Start the server:
   `npm start`

No global FFmpeg or yt-dlp installation is required. The project uses packaged
application dependencies for media processing and YouTube extraction. Internet
access is still required while the app retrieves the video you selected.

## Development

- Run locally with hot reload:
  `npm run dev`

## API

- POST `/api/analyze`
- POST `/api/download/video`
- POST `/api/download/audio`
- GET `/api/download/:id`
- DELETE `/api/delete/:id`
- GET `/api/status`

## Environment Variables

- `PORT`
- `HOST`
- `NODE_ENV`
- `DOWNLOAD_DIR`
- `TEMP_DIR`
- `LOG_DIR`
- `MAX_DOWNLOADS`
- `DOWNLOAD_FRAGMENTS`
- `DOWNLOAD_HTTP_CHUNK_SIZE`
- `DOWNLOAD_BUFFER_SIZE`
- `DOWNLOAD_THROTTLED_RATE`
- `FAST_VIDEO_MODE`
- `FAST_AUDIO_MODE`
- `FAST_TRIM_MODE`
- `SECTION_DOWNLOAD_MODE`
- `FORCE_KEYFRAMES_AT_CUTS`
- `MAX_PREVIEW_SECONDS`
- `FFMPEG_VIDEO_PRESET`
- `YTDLP_EXTERNAL_DOWNLOADER`
- `YTDLP_EXTERNAL_DOWNLOADER_ARGS`
- `CLEANUP_INTERVAL_MINUTES`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX`

## Use responsibly

Download only media that you own or have permission to download. You are
responsible for complying with YouTube's terms and applicable copyright laws.

## Testing

- `npm test`
