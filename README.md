# ReeltoMP3

Simple web app to preview an Instagram Reel and download its audio as MP3.

## Features
- Paste a public Reel URL
- Preview thumbnail/video
- Download MP3 via server-side conversion

## Requirements
- Python 3.10+

## Local setup
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```
Open `http://localhost:3000`.

## Environment variables (optional)
Copy `.env.example` to `.env` and customize:
- `USER_AGENT`
- `IG_SESSIONID` (optional, improves reliability for some reels)
- `FFMPEG_PATH` (optional, set if ffmpeg is preinstalled)
 - `IG_APP_ID` (optional, Instagram web app id)
 - `DEBUG_ERRORS` (optional, set to `true` to include error details)
If reels fail to load, add `IG_SESSIONID` from a logged-in Instagram session.

## Render deployment
1. Create a new Web Service on Render
2. Connect your GitHub repo
3. Build command: `pip install -r requirements.txt`
4. Start command: `gunicorn app:app`
5. Add env vars if needed

## Notes
- Only public reels are supported.
- Respect creators and platform guidelines.
- Instagram frequently changes its public pages; scraping may break and require header or cookie updates.
- You can also paste a direct Instagram CDN MP4 link if you already have it.
- This backend uses `app.py`. If you still have old Node files like `server.js` or `package.json`, you can remove them.
