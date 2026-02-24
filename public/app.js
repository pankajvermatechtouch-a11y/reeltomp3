const form = document.getElementById("reelForm");
const reelUrlInput = document.getElementById("reelUrl");
const statusEl = document.getElementById("status");
const previewMedia = document.getElementById("previewMedia");
const reelTitle = document.getElementById("reelTitle");
const audioName = document.getElementById("audioName");
const downloadBtn = document.getElementById("downloadBtn");
const resetBtn = document.getElementById("resetBtn");
const fineprint = document.getElementById("fineprint");
const errorModal = document.getElementById("errorModal");
const closeModal = document.getElementById("closeModal");
const retryBtn = document.getElementById("retryBtn");
const modalMessage = document.getElementById("modalMessage");
const previewCard = document.getElementById("previewCard");
const audioNotice = document.getElementById("audioNotice");
const pasteBtn = document.getElementById("pasteBtn");

const DOWNLOAD_LABEL = "Download MP3";
let downloadResetTimer = null;
let downloadMessageTimer = null;
let downloadStartTimer = null;

const isMobile = () => window.matchMedia("(max-width: 700px)").matches;

const showAudioNotice = () => {
  audioNotice.hidden = false;
  audioNotice.classList.add("visible");
};

const hideAudioNotice = () => {
  audioNotice.hidden = true;
  audioNotice.classList.remove("visible");
};

const setStatus = (message, tone = "default", isLoading = false, isDownloading = false) => {
  statusEl.textContent = message;
  statusEl.style.color =
    tone === "error" ? "#b42318" : tone === "success" ? "#0f766e" : "#2f7b7b";
  statusEl.classList.toggle("loading", isLoading);
  statusEl.classList.toggle("is-empty", !message);
  statusEl.classList.toggle("downloading", isDownloading);
};

const openModal = (message) => {
  modalMessage.textContent =
    message || "Instagram blocked this request. Please try again in a few minutes.";
  errorModal.classList.add("active");
  errorModal.setAttribute("aria-hidden", "false");
};

const closeErrorModal = () => {
  errorModal.classList.remove("active");
  errorModal.setAttribute("aria-hidden", "true");
};

const setPreview = (data) => {
  reelTitle.textContent = data.title || "Instagram Reel";
  audioName.textContent = `Audio: ${data.audioName || "Unknown audio"}`;

  previewMedia.innerHTML = "";
  const hasContent = Boolean(data.previewUrl || data.thumbnailUrl || data.mp3Url);
  if (!hasContent) {
    previewCard.classList.add("is-hidden");
    return;
  }

  let revealed = false;
  const revealPreview = () => {
    if (revealed) {
      return;
    }
    revealed = true;
    previewCard.classList.remove("is-hidden");
    previewCard.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (data.previewUrl) {
    const video = document.createElement("video");
    video.src = data.previewUrl;
    if (data.thumbnailUrl) {
      video.poster = data.thumbnailUrl;
    }
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    previewMedia.appendChild(video);
    revealPreview();
    video.addEventListener("loadeddata", revealPreview, { once: true });
    video.addEventListener("error", () => {
      if (!data.thumbnailUrl) {
        return;
      }
      previewMedia.innerHTML = "";
      const img = document.createElement("img");
      img.src = data.thumbnailUrl;
      img.alt = "Reel preview thumbnail";
      img.loading = "eager";
      img.decoding = "async";
      previewMedia.appendChild(img);
      revealPreview();
      img.addEventListener("load", revealPreview, { once: true });
    });
  } else if (data.thumbnailUrl) {
    const img = document.createElement("img");
    img.src = data.thumbnailUrl;
    img.alt = "Reel preview thumbnail";
    img.loading = "eager";
    img.decoding = "async";
    previewMedia.appendChild(img);
    revealPreview();
    img.addEventListener("load", revealPreview, { once: true });
  } else {
    previewMedia.innerHTML =
      "<div class=\"media-placeholder\"><div class=\"play-icon\"></div><span>No preview available</span></div>";
    revealPreview();
  }

  const shouldShow = Boolean(data.mp3Url || data.previewUrl || data.thumbnailUrl);
  if (!shouldShow) {
    previewCard.classList.add("is-hidden");
  }

  if (data.mp3Url) {
    downloadBtn.href = data.mp3Url;
    downloadBtn.setAttribute("download", data.downloadName || "reel-audio.mp3");
    downloadBtn.classList.remove("disabled");
    downloadBtn.classList.remove("loading");
    downloadBtn.textContent = DOWNLOAD_LABEL;
    fineprint.textContent = "Ready to download.";
  } else {
    downloadBtn.href = "#";
    downloadBtn.removeAttribute("download");
    downloadBtn.classList.add("disabled");
    downloadBtn.classList.remove("loading");
    downloadBtn.textContent = DOWNLOAD_LABEL;
    fineprint.textContent = "Download will start once we fetch the audio file.";
  }

};

const validateUrl = (value) => {
  try {
    const url = new URL(value);
    const isReel = url.hostname.includes("instagram.com") && url.pathname.includes("/reel/");
    const isAudio = url.hostname.includes("instagram.com") && url.pathname.includes("/audio/");
    const isMp4 = url.pathname.toLowerCase().includes(".mp4");
    return isReel || isAudio || isMp4;
  } catch {
    return false;
  }
};

const fetchReel = async (url) => {
  let statusMessage = "Fetching reel details...";
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("instagram.com") && parsed.pathname.includes("/audio/")) {
      statusMessage = "Audio link detected. Selecting a reel...";
      showAudioNotice();
      setStatus("", "default", false);
      previewCard.classList.add("is-hidden");
      return;
    }
  } catch {
    // ignore
  }
  setStatus(statusMessage, "default", true);
  downloadBtn.classList.add("disabled");
  previewCard.classList.add("is-hidden");
  hideAudioNotice();

  try {
    const response = await fetch(`/api/reel?url=${encodeURIComponent(url)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Reel lookup failed");
    }
    setPreview(data);
    setStatus("Reel loaded.", "success", false);
    hideAudioNotice();
  } catch (error) {
    const message =
      error.message || "Could not load reel. Please try again after some time.";
    setStatus(message, "error", false);
    openModal(message);
  }
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = reelUrlInput.value.trim();
  if (!validateUrl(url)) {
    setStatus("Please enter a valid Instagram Reel URL.", "error");
    hideAudioNotice();
    return;
  }
  fetchReel(url);
});

reelUrlInput.addEventListener("input", () => {
  hideAudioNotice();
});

pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      reelUrlInput.value = text.trim();
    }
  } catch {
    setStatus("Clipboard access blocked. Paste manually.", "error", false);
  }
});

downloadBtn.addEventListener("click", () => {
  if (downloadBtn.classList.contains("disabled")) {
    return;
  }
  downloadBtn.classList.add("loading");
  downloadBtn.textContent = "Preparing MP3...";
  setStatus("Preparing MP3...", "default", true, false);

  if (downloadStartTimer) {
    clearTimeout(downloadStartTimer);
  }
  downloadStartTimer = setTimeout(() => {
    downloadBtn.textContent = "Downloading... Wait";
    setStatus("Downloading... Wait", "default", true, true);
  }, 3000);

  if (downloadResetTimer) {
    clearTimeout(downloadResetTimer);
  }

  if (downloadMessageTimer) {
    clearTimeout(downloadMessageTimer);
  }

  downloadResetTimer = setTimeout(() => {
    downloadBtn.classList.remove("loading");
    downloadBtn.textContent = DOWNLOAD_LABEL;
    setStatus("", "default", false, false);
  }, 20000);
});

window.addEventListener("focus", () => {
  if (downloadBtn.classList.contains("loading")) {
    downloadBtn.classList.remove("loading");
    downloadBtn.textContent = DOWNLOAD_LABEL;
    setStatus("", "default", false, false);
  }
});

closeModal.addEventListener("click", closeErrorModal);
retryBtn.addEventListener("click", () => {
  closeErrorModal();
  form.requestSubmit();
});

resetBtn.addEventListener("click", () => {
  reelUrlInput.value = "";
  setPreview({});
  setStatus("");
  fineprint.textContent = "Download will start once we fetch the audio file.";
  closeErrorModal();
  hideAudioNotice();
  document.getElementById("top").scrollIntoView({ behavior: "smooth", block: "start" });
});

errorModal.addEventListener("click", (event) => {
  if (event.target === errorModal) {
    closeErrorModal();
  }
});

setPreview({});
