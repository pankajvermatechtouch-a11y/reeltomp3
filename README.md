# ReeltoMP3

Simple web app to preview an Instagram Reel and download its audio as MP3.

## Features
- Paste a public Reel URL
- Preview thumbnail/video
- Download MP3 via server-side conversion

## Requirements
- Node.js 18+

## Local setup
```bash
npm install
npm start
```
Open `http://localhost:3000`.

## Environment variables (optional)
Copy `.env.example` to `.env` and customize:
- `USER_AGENT`
- `IG_APP_ID`
- `IG_SESSIONID` (optional, improves reliability for some reels)

## Render deployment
Use the steps in the response from the assistant (same as below):
1. Create a new Web Service on Render
2. Connect your GitHub repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add env vars if needed

## Notes
- Only public reels are supported.
- Respect creators and platform guidelines.
- Instagram frequently changes its public pages; scraping may break and require header or cookie updates.
