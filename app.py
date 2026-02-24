import os
import re
import shutil
import subprocess
import tempfile
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

HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.instagram.com/",
}

ALLOWED_MEDIA_HOSTS = ["cdninstagram.com", "fbcdn.net", "instagram.com", "igcdn.com"]

app = Flask(__name__, static_folder=str(PUBLIC_DIR), static_url_path="")


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


def extract_shortcode(value: str) -> str:
    try:
        url = urlparse(value)
        match = re.search(r"/reel/([^/?#]+)", url.path)
        if match:
            return match.group(1)
    except Exception:
        return ""
    return ""


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


def fetch_instagram_post(shortcode: str):
    loader = instaloader.Instaloader(
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        quiet=True,
    )
    loader.context.session.headers.update(HEADERS)
    if IG_SESSIONID:
        loader.context.session.cookies.set("sessionid", IG_SESSIONID, domain=".instagram.com")
    return instaloader.Post.from_shortcode(loader.context, shortcode)


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

    if not url or (not is_instagram_reel_url(url) and not is_direct_mp4_url(url)):
        return jsonify({"error": "Invalid URL. Paste a Reel page or direct MP4 URL."}), 400

    try:
        if is_direct_mp4_url(url):
            video_url = url
            file_part = Path(urlparse(url).path).name.replace(".mp4", "")
            title = file_part or "Instagram Reel"
            audio_name = file_part or "Original audio"
            thumbnail_url = ""
        else:
            shortcode = extract_shortcode(url)
            if not shortcode:
                return jsonify({"error": "Could not read reel shortcode."}), 400
            post = fetch_instagram_post(shortcode)
            if not post.is_video:
                return jsonify({"error": "This Reel has no video."}), 400
            video_url = post.video_url
            if not video_url:
                return jsonify({"error": "Could not locate a playable reel video."}), 502
            title = post.caption or f"Reel by @{post.owner_username}"
            audio_name = extract_audio_name(post) or "Original audio"
            thumbnail_url = post.url

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
    except instaloader.exceptions.InstaloaderException:
        return jsonify({"error": "Instagram blocked this reel. Try another URL."}), 502
    except Exception:
        return jsonify({"error": "Failed to fetch reel details."}), 500


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
