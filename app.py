import os
import re
import shutil
import subprocess
import tempfile
import logging
from pathlib import Path
from urllib.parse import quote, urlparse

import instaloader
import requests
from flask import Flask, Response, after_this_request, jsonify, request, send_file, send_from_directory

APP_ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = APP_ROOT / "public"

USER_AGENT = os.getenv(
    "USER_AGENT",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
)
IG_SESSIONID = os.getenv("IG_SESSIONID", "").strip()
IG_APP_ID = os.getenv("IG_APP_ID", "936619743392459").strip()
DEBUG_ERRORS = os.getenv("DEBUG_ERRORS", "false").lower() == "true"

HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.instagram.com/",
}
if IG_APP_ID:
    HEADERS["X-IG-App-ID"] = IG_APP_ID

ALLOWED_MEDIA_HOSTS = ["cdninstagram.com", "fbcdn.net", "instagram.com", "igcdn.com"]
SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
SHORTCODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{5,}$")

app = Flask(__name__, static_folder=str(PUBLIC_DIR), static_url_path="")
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("reeltomp3")


def get_requests_session(url: str | None = None) -> requests.Session:
    session = requests.Session()
    session.headers.update(HEADERS)
    if IG_SESSIONID and url:
        host = urlparse(url).hostname or ""
        if host.endswith("instagram.com"):
            session.cookies.set("sessionid", IG_SESSIONID, domain=".instagram.com")
    return session


def sanitize_filename(value: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|]+", "", value or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:80] if cleaned else "reel-audio"


def is_instagram_reel_url(value: str) -> bool:
    try:
        url = urlparse(value)
        return "instagram.com" in url.netloc and "/reel/" in url.path
    except Exception:
        return False


def is_audio_url(value: str) -> bool:
    try:
        url = urlparse(value)
        return "instagram.com" in url.netloc and ("/audio/" in url.path or "/reels/audio/" in url.path)
    except Exception:
        return False


def extract_shortcode(value: str) -> str:
    try:
        url = urlparse(value)
        match = re.search(r"/reel/([^/?#]+)", url.path)
        if match:
            return match.group(1)
    except Exception:
        return ""
    return ""


def extract_audio_id(value: str) -> str:
    try:
        url = urlparse(value)
        match = re.search(r"/audio/([0-9]+)", url.path)
        if match:
            return match.group(1)
    except Exception:
        return ""
    return ""


def is_shortcode(value: str) -> bool:
    return bool(SHORTCODE_PATTERN.match(value or ""))


def shortcode_to_media_id(shortcode: str) -> int:
    media_id = 0
    for ch in shortcode:
        media_id = media_id * 64 + SHORTCODE_ALPHABET.index(ch)
    return media_id


def is_allowed_media_host(value: str) -> bool:
    try:
        url = urlparse(value)
        host = url.hostname.lower() if url.hostname else ""
        return any(host == domain or host.endswith("." + domain) for domain in ALLOWED_MEDIA_HOSTS)
    except Exception:
        return False


def is_direct_mp4_url(value: str) -> bool:
    try:
        url = urlparse(value)
        return url.scheme in {"https", "http"} and url.path.lower().endswith(".mp4") and is_allowed_media_host(value)
    except Exception:
        return False


def get_ffmpeg_path() -> str:
    env_path = os.getenv("FFMPEG_PATH")
    if env_path:
        return env_path

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def configure_instaloader_session(loader: instaloader.Instaloader):
    context = loader.context
    session = getattr(context, "_session", None) or getattr(context, "session", None)
    if session is None:
        session = requests.Session()
        try:
            context._session = session
        except Exception:
            pass
    session.headers.update(HEADERS)
    if IG_SESSIONID:
        session.cookies.set("sessionid", IG_SESSIONID, domain=".instagram.com")
    return session


def fetch_instagram_post(shortcode: str):
    loader = instaloader.Instaloader(
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        quiet=True,
    )
    configure_instaloader_session(loader)
    return instaloader.Post.from_shortcode(loader.context, shortcode)


def fetch_reel_json(shortcode: str):
    session = get_requests_session("https://www.instagram.com/")
    url = f"https://www.instagram.com/reel/{shortcode}/?__a=1&__d=dis"
    response = session.get(url, timeout=20)
    logger.info("Public JSON status=%s content-type=%s", response.status_code, response.headers.get("content-type"))
    if response.ok:
        return response.json()
    return None


def parse_reel_json(data: dict):
    media = (
        (data or {}).get("graphql", {}).get("shortcode_media")
        or (data or {}).get("items", [{}])[0]
        or {}
    )
    caption_edges = media.get("edge_media_to_caption", {}).get("edges", [])
    caption = caption_edges[0]["node"].get("text") if caption_edges else ""
    owner = media.get("owner", {}).get("username") or ""

    video_url = media.get("video_url") or ""
    if not video_url and media.get("video_versions"):
        video_url = media["video_versions"][0].get("url", "")

    thumbnail = (
        media.get("display_url")
        or media.get("thumbnail_src")
        or (media.get("display_resources") or [{}])[-1].get("src", "")
    )

    music = (
        media.get("clips_music_attribution_info")
        or media.get("music_attribution_info")
        or media.get("music_info")
        or media.get("audio")
        or {}
    )
    title = (
        (music.get("song_title") and music.get("artist_name") and f"{music.get('song_title')} - {music.get('artist_name')}")
        or music.get("song_title")
        or music.get("title")
        or music.get("original_audio_title")
        or ""
    )

    return {
        "title": caption or (f"Reel by @{owner}" if owner else "Instagram Reel"),
        "audioName": title or "Original audio",
        "thumbnailUrl": thumbnail or "",
        "videoUrl": video_url or "",
    }


def fetch_private_api(shortcode: str):
    media_id = shortcode_to_media_id(shortcode)
    session = get_requests_session("https://www.instagram.com/")
    url = f"https://i.instagram.com/api/v1/media/{media_id}/info/"
    headers = dict(session.headers)
    headers["Accept"] = "application/json"
    if IG_APP_ID:
        headers["X-IG-App-ID"] = IG_APP_ID
    response = session.get(url, headers=headers, timeout=20)
    logger.info("Private API status=%s content-type=%s", response.status_code, response.headers.get("content-type"))
    if response.ok:
        return response.json()
    return None


def parse_private_api(data: dict):
    item = (data or {}).get("items", [{}])[0] or {}
    caption = (item.get("caption") or {}).get("text", "")
    user = (item.get("user") or {}).get("username", "")

    video_versions = item.get("video_versions") or []
    video_url = ""
    if video_versions:
        video_url = video_versions[-1].get("url") or video_versions[0].get("url", "")

    thumbnail = (
        (item.get("image_versions2") or {}).get("candidates", [{}])[0].get("url", "")
    )

    audio_title = ""
    audio = item.get("audio") or {}
    music_meta = item.get("music_metadata") or {}
    if audio:
        audio_title = audio.get("audio_title") or audio.get("original_sound_info", {}).get("original_audio_title", "")
        artist = audio.get("artist_name")
        if audio_title and artist:
            audio_title = f"{audio_title} - {artist}"
    if not audio_title and music_meta:
        asset = music_meta.get("music_asset_info") or {}
        title = asset.get("title") or asset.get("display_title")
        artist = asset.get("display_artist")
        if title and artist:
            audio_title = f"{title} - {artist}"
        else:
            audio_title = title or ""

    return {
        "title": caption or (f"Reel by @{user}" if user else "Instagram Reel"),
        "audioName": audio_title or "Original audio",
        "thumbnailUrl": thumbnail or "",
        "videoUrl": video_url or "",
    }


def find_shortcode_in_json(obj) -> str:
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in {"shortcode", "code"} and isinstance(value, str) and is_shortcode(value):
                return value
            found = find_shortcode_in_json(value)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_shortcode_in_json(item)
            if found:
                return found
    return ""


def fetch_audio_json(audio_id: str):
    session = get_requests_session("https://www.instagram.com/")
    url = f"https://www.instagram.com/reels/audio/{audio_id}/?__a=1&__d=dis"
    response = session.get(url, timeout=20)
    logger.info("Audio JSON status=%s content-type=%s", response.status_code, response.headers.get("content-type"))
    if response.ok:
        try:
            return response.json()
        except Exception:
            return None
    return None


def fetch_audio_private_api(audio_id: str):
    session = get_requests_session("https://www.instagram.com/")
    url = f"https://i.instagram.com/api/v1/music/audio/{audio_id}/"
    headers = dict(session.headers)
    headers["Accept"] = "application/json"
    if IG_APP_ID:
        headers["X-IG-App-ID"] = IG_APP_ID
    response = session.get(url, headers=headers, timeout=20)
    logger.info("Audio private status=%s content-type=%s", response.status_code, response.headers.get("content-type"))
    if response.ok:
        try:
            return response.json()
        except Exception:
            return None
    return None


def extract_shortcode_from_audio_page(audio_url: str) -> str:
    audio_id = extract_audio_id(audio_url)
    if audio_id:
        data = fetch_audio_json(audio_id)
        shortcode = find_shortcode_in_json(data or {})
        if shortcode:
            return shortcode

        private_data = fetch_audio_private_api(audio_id)
        shortcode = find_shortcode_in_json(private_data or {})
        if shortcode:
            return shortcode

    session = get_requests_session("https://www.instagram.com/")
    response = session.get(audio_url, timeout=20)
    logger.info("Audio page status=%s content-type=%s", response.status_code, response.headers.get("content-type"))
    if not response.ok:
        return ""
    html = response.text
    html = html.replace("\\u002F", "/").replace("\\/", "/")

    match = re.search(r'"shortcode"\\s*:\\s*"([A-Za-z0-9_-]+)"', html)
    if match and is_shortcode(match.group(1)):
        return match.group(1)

    match = re.search(r"/reel/([A-Za-z0-9_-]+)/", html)
    if match and is_shortcode(match.group(1)):
        return match.group(1)

    return ""


def extract_audio_name(post) -> str:
    try:
        metadata = getattr(post, "_full_metadata_dict", None)
        if not metadata:
            return ""
        media = metadata.get("shortcode_media", {})
        music = (
            media.get("clips_music_attribution_info")
            or media.get("music_attribution_info")
            or media.get("music_info")
            or media.get("audio")
            or {}
        )
        title = music.get("song_title") or music.get("title") or music.get("original_audio_title")
        artist = music.get("artist_name")
        if title and artist:
            return f"{title} - {artist}"
        return title or ""
    except Exception:
        return ""


def download_file(url: str, dest_path: Path):
    session = get_requests_session(url)
    with session.get(url, stream=True, timeout=30) as response:
        response.raise_for_status()
        with open(dest_path, "wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 64):
                if chunk:
                    handle.write(chunk)


def run_ffmpeg(input_path: Path, output_path: Path):
    ffmpeg_path = get_ffmpeg_path()
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(input_path),
        "-vn",
        "-acodec",
        "libmp3lame",
        "-b:a",
        "192k",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr or "ffmpeg failed")


@app.get("/")
def serve_index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.get("/api/reel")
def api_reel():
    url = request.args.get("url", "").strip()

    is_reel = is_instagram_reel_url(url)
    is_audio = is_audio_url(url)
    is_mp4 = is_direct_mp4_url(url)
    logger.info("Request url=%s type reel=%s audio=%s mp4=%s", url, is_reel, is_audio, is_mp4)

    if not url or (not is_reel and not is_mp4 and not is_audio):
        return (
            jsonify({"error": "Invalid URL. Paste a Reel page, audio page, or direct MP4 URL."}),
            400,
        )

    try:
        if is_direct_mp4_url(url):
            video_url = url
            file_part = Path(urlparse(url).path).name.replace(".mp4", "")
            title = file_part or "Instagram Reel"
            audio_name = file_part or "Original audio"
            thumbnail_url = ""
        else:
            shortcode = extract_shortcode(url)
            if not shortcode and is_audio:
                audio_id = extract_audio_id(url)
                logger.info("Audio link detected id=%s", audio_id or "none")
                shortcode = extract_shortcode_from_audio_page(url)
                if not shortcode:
                    return jsonify({"error": "Could not find a reel for this audio link."}), 400
            if not shortcode:
                return jsonify({"error": "Could not read reel shortcode."}), 400

            post = None
            try:
                post = fetch_instagram_post(shortcode)
            except instaloader.exceptions.InstaloaderException as exc:
                logger.warning("Instaloader failed: %s", exc)

            if post and not post.is_video:
                return jsonify({"error": "This Reel has no video."}), 400

            if post and post.video_url:
                video_url = post.video_url
                title = post.caption or f"Reel by @{post.owner_username}"
                audio_name = extract_audio_name(post) or "Original audio"
                thumbnail_url = post.url
            else:
                fallback = fetch_reel_json(shortcode)
                parsed = parse_reel_json(fallback or {})
                video_url = parsed.get("videoUrl", "")
                title = parsed.get("title", "Instagram Reel")
                audio_name = parsed.get("audioName", "Original audio")
                thumbnail_url = parsed.get("thumbnailUrl", "")

            if not video_url:
                private_data = fetch_private_api(shortcode)
                parsed_private = parse_private_api(private_data or {})
                video_url = parsed_private.get("videoUrl", "")
                if video_url:
                    title = parsed_private.get("title", title)
                    audio_name = parsed_private.get("audioName", audio_name)
                    thumbnail_url = parsed_private.get("thumbnailUrl", thumbnail_url)
                else:
                    return jsonify({"error": "Could not locate a playable reel video."}), 502

        download_name = sanitize_filename(audio_name or title)

        return jsonify(
            {
                "title": title or "Instagram Reel",
                "audioName": audio_name or "Original audio",
                "thumbnailUrl": thumbnail_url or "",
                "previewUrl": f"/api/reel/preview?url={quote(video_url)}",
                "mp3Url": f"/api/reel/audio?url={quote(video_url)}&name={quote(download_name)}",
                "downloadName": f"{download_name}.mp3",
            }
        )
    except Exception as exc:
        logger.exception("Failed to fetch reel details")
        payload = {"error": "Failed to fetch reel details."}
        if DEBUG_ERRORS:
            payload["details"] = str(exc)
        return jsonify(payload), 500


@app.get("/api/reel/preview")
def api_preview():
    url = request.args.get("url", "").strip()
    if not url or not is_allowed_media_host(url):
        return "Invalid media URL", 400

    try:
        session = get_requests_session(url)
        upstream = session.get(url, stream=True, timeout=30)
        upstream.raise_for_status()

        def generate():
            for chunk in upstream.iter_content(chunk_size=1024 * 64):
                if chunk:
                    yield chunk

        content_type = upstream.headers.get("content-type", "video/mp4")
        return Response(generate(), content_type=content_type)
    except Exception:
        return "Preview failed", 500


@app.get("/api/reel/audio")
def api_audio():
    url = request.args.get("url", "").strip()
    name = request.args.get("name", "reel-audio")

    if not url or not is_allowed_media_host(url):
        return "Invalid media URL", 400

    safe_name = sanitize_filename(name)
    tmp_dir = Path(tempfile.mkdtemp(prefix="reeltomp3_"))
    video_path = tmp_dir / "input.mp4"
    mp3_path = tmp_dir / "output.mp3"

    @after_this_request
    def cleanup(response):
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return response

    try:
        download_file(url, video_path)
        run_ffmpeg(video_path, mp3_path)
        return send_file(
            mp3_path,
            mimetype="audio/mpeg",
            as_attachment=True,
            download_name=f"{safe_name}.mp3",
        )
    except Exception:
        return "Audio conversion failed", 500


@app.get("/api/health")
def api_health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "3000"))
    app.run(host="0.0.0.0", port=port)
