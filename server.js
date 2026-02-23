import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegPath from "ffmpeg-static";
import { load } from "cheerio";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

const USER_AGENT =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const IG_APP_ID = process.env.IG_APP_ID || "936619743392459";
const IG_SESSIONID = process.env.IG_SESSIONID || "";

app.use(express.static(path.join(__dirname, "public")));

const headers = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
  "X-IG-App-ID": IG_APP_ID,
  Referer: "https://www.instagram.com/",
};

if (IG_SESSIONID) {
  headers.Cookie = `sessionid=${IG_SESSIONID}`;
}

const sanitizeFilename = (value) => {
  const cleaned = value
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length ? cleaned.slice(0, 80) : "reel-audio";
};

const isValidReelUrl = (value) => {
  try {
    const url = new URL(value);
    return url.hostname.includes("instagram.com") && url.pathname.includes("/reel/");
  } catch {
    return false;
  }
};

const normalizeReelUrl = (value) => {
  const url = new URL(value);
  const match = url.pathname.match(/\/reel\/([^/?#]+)/);
  const shortcode = match ? match[1] : "";
  if (!shortcode) {
    return value;
  }
  return `https://www.instagram.com/reel/${shortcode}/`;
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
};

const extractFromGraphql = (media) => {
  if (!media) return {};

  const caption =
    media.edge_media_to_caption?.edges?.[0]?.node?.text || media.caption?.text || "";
  const username = media.owner?.username || media.user?.username || "";
  const title = media.title || caption || (username ? `Reel by @${username}` : "");

  const videoUrl =
    media.video_url ||
    media.video_versions?.[0]?.url ||
    media.video_versions?.[media.video_versions?.length - 1]?.url ||
    "";

  const thumbnailUrl =
    media.display_url ||
    media.thumbnail_src ||
    media.display_resources?.[media.display_resources?.length - 1]?.src ||
    media.image_versions2?.candidates?.[0]?.url ||
    "";

  const musicInfo =
    media.clips_music_attribution_info ||
    media.music_attribution_info ||
    media.music_info ||
    media.clips_metadata?.music_info?.music_asset_info ||
    {};

  const audioName =
    (musicInfo.song_title && musicInfo.artist_name
      ? `${musicInfo.song_title} - ${musicInfo.artist_name}`
      : musicInfo.song_title ||
        musicInfo.title ||
        musicInfo.original_audio_title ||
        media.audio?.title ||
        "") || "";

  return { title, audioName, thumbnailUrl, videoUrl };
};

const extractFromHtml = (html) => {
  const $ = load(html);

  const ogTitle = $("meta[property='og:title']").attr("content");
  const ogImage = $("meta[property='og:image']").attr("content");
  const ogVideo =
    $("meta[property='og:video']").attr("content") ||
    $("meta[property='og:video:secure_url']").attr("content");

  let ldData = {};
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const json = JSON.parse($(el).text());
      const candidates = Array.isArray(json)
        ? json
        : json && json["@graph"]
        ? json["@graph"]
        : [json];
      for (const candidate of candidates) {
        if (candidate && (candidate["@type"] === "VideoObject" || candidate.contentUrl)) {
          ldData = candidate;
          break;
        }
      }
    } catch {
      // ignore
    }
  });

  const sharedMatch = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});/);
  let sharedData = {};
  if (sharedMatch) {
    try {
      sharedData = JSON.parse(sharedMatch[1]);
    } catch {
      sharedData = {};
    }
  }

  const media =
    sharedData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media ||
    sharedData?.entry_data?.ReelPage?.[0]?.graphql?.shortcode_media ||
    null;

  const fromGraphql = extractFromGraphql(media);

  const ldThumbnail = Array.isArray(ldData?.thumbnailUrl)
    ? ldData.thumbnailUrl[0]
    : ldData?.thumbnailUrl;

  return {
    title: fromGraphql.title || ldData?.name || ogTitle || "Instagram Reel",
    audioName: fromGraphql.audioName || "Original audio",
    thumbnailUrl: fromGraphql.thumbnailUrl || ldThumbnail || ogImage || "",
    videoUrl: fromGraphql.videoUrl || ldData?.contentUrl || ogVideo || "",
  };
};

const fetchReelData = async (reelUrl) => {
  const normalized = normalizeReelUrl(reelUrl);

  const apiUrl = `${normalized}?__a=1&__d=dis`;
  try {
    const response = await fetchWithTimeout(apiUrl, { headers });
    if (response.ok) {
      const json = await response.json();
      const media = json?.graphql?.shortcode_media || json?.items?.[0] || null;
      const parsed = extractFromGraphql(media);
      if (parsed.videoUrl || parsed.thumbnailUrl) {
        return parsed;
      }
    }
  } catch {
    // fallback to HTML
  }

  const htmlResponse = await fetchWithTimeout(normalized, { headers });
  if (!htmlResponse.ok) {
    throw new Error("Unable to fetch reel HTML");
  }
  const html = await htmlResponse.text();
  return extractFromHtml(html);
};

const isSafeMediaHost = (value) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = ["cdninstagram.com", "fbcdn.net", "instagram.com"];
    const isAllowed = allowed.some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
    return (
      url.protocol === "https:" &&
      isAllowed
    );
  } catch {
    return false;
  }
};

app.get("/api/reel", async (req, res) => {
  const { url } = req.query;

  if (!url || !isValidReelUrl(url)) {
    return res.status(400).json({ error: "Invalid Instagram Reel URL." });
  }

  try {
    const data = await fetchReelData(url);
    if (!data.videoUrl) {
      return res
        .status(502)
        .json({ error: "Could not locate a playable reel video." });
    }

    const downloadName = sanitizeFilename(data.audioName || data.title || "reel-audio");
    const videoUrl = data.videoUrl;

    res.json({
      title: data.title || "Instagram Reel",
      audioName: data.audioName || "Original audio",
      thumbnailUrl: data.thumbnailUrl || "",
      previewUrl: `/api/reel/preview?url=${encodeURIComponent(videoUrl)}`,
      mp3Url: `/api/reel/audio?url=${encodeURIComponent(videoUrl)}&name=${encodeURIComponent(
        downloadName
      )}`,
      downloadName: `${downloadName}.mp3`,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch reel details." });
  }
});

app.get("/api/reel/preview", async (req, res) => {
  const { url } = req.query;
  if (!url || !isSafeMediaHost(url)) {
    return res.status(400).send("Invalid media URL");
  }

  try {
    const response = await fetchWithTimeout(url, { headers }, 20000);
    if (!response.ok || !response.body) {
      return res.status(502).send("Unable to fetch preview");
    }

    res.setHeader("Content-Type", response.headers.get("content-type") || "video/mp4");
    await pipeline(Readable.fromWeb(response.body), res);
  } catch {
    res.status(500).send("Preview failed");
  }
});

app.get("/api/reel/audio", async (req, res) => {
  const { url, name } = req.query;
  if (!url || !isSafeMediaHost(url)) {
    return res.status(400).send("Invalid media URL");
  }

  if (!ffmpegPath) {
    return res.status(500).send("ffmpeg not available");
  }

  const safeName = sanitizeFilename(name ? String(name) : "reel-audio");

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=\"${safeName}.mp3\"`
  );

  const ffmpeg = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    url,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-b:a",
    "192k",
    "-f",
    "mp3",
    "pipe:1",
  ]);

  ffmpeg.stdout.pipe(res);

  ffmpeg.on("error", () => {
    if (!res.headersSent) {
      res.status(500).send("Audio conversion failed");
    }
  });

  ffmpeg.stderr.on("data", () => {
    // ignore log noise
  });

  res.on("close", () => {
    ffmpeg.kill("SIGKILL");
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
