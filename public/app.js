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

const DOWNLOAD_LABEL = "Download MP3";
let downloadResetTimer = null;
let downloadMessageTimer = null;
let downloadStartTimer = null;

const isMobile = () => window.matchMedia("(max-width: 700px)").matches;

const setStatus = (message, tone = "default", isLoading = false) => {
  statusEl.textContent = message;
  statusEl.style.color =
    tone === "error" ? "#b42318" : tone === "success" ? "#0f766e" : "#2f7b7b";
  statusEl.classList.toggle("loading", isLoading);
  statusEl.classList.toggle("is-empty", !message);
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
  const preferImage = isMobile() && Boolean(data.thumbnailUrl);
  if (!preferImage && data.previewUrl) {
    const video = document.createElement("video");
    video.src = data.previewUrl;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    previewMedia.appendChild(video);
  } else if (data.thumbnailUrl) {
    const img = document.createElement("img");
    img.src = data.thumbnailUrl;
    img.alt = "Reel preview thumbnail";
    previewMedia.appendChild(img);
  } else {
    previewMedia.innerHTML =
      "<div class=\"media-placeholder\"><div class=\"play-icon\"></div><span>No preview available</span></div>";
  }

  const hasPreview = Boolean(data.mp3Url || data.previewUrl || data.thumbnailUrl);
  previewCard.classList.toggle("is-hidden", !hasPreview);

  if (data.mp3Url) {
    downloadBtn.href = data.mp3Url;
    downloadBtn.setAttribute("download", data.downloadName || "reel-audio.mp3");
    downloadBtn.classList.remove("disabled");
    downloadBtn.classList.remove("loading");
    downloadBtn.textContent = DOWNLOAD_LABEL;
    fineprint.textContent = "Ready to download.";
    previewCard.scrollIntoView({ behavior: "smooth", block: "start" });
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
    const isMp4 = url.pathname.toLowerCase().includes(".mp4");
    return isReel || isMp4;
  } catch {
    return false;
  }
};

const fetchReel = async (url) => {
  setStatus("Fetching reel details...", "default", true);
  downloadBtn.classList.add("disabled");
  previewCard.classList.remove("is-hidden");

  try {
    const response = await fetch(`/api/reel?url=${encodeURIComponent(url)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Reel lookup failed");
    }
    setPreview(data);
    setStatus("Reel loaded.", "success", false);
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
    return;
  }
  fetchReel(url);
});

downloadBtn.addEventListener("click", () => {
  if (downloadBtn.classList.contains("disabled")) {
    return;
  }
  downloadBtn.classList.add("loading");
  downloadBtn.textContent = "Preparing MP3...";
  setStatus("Preparing MP3. This can take 10-30 seconds.", "default", true);

  if (downloadStartTimer) {
    clearTimeout(downloadStartTimer);
  }
  downloadStartTimer = setTimeout(() => {
    setStatus("Download started. If it doesn't start, tap again.", "default", true);
  }, 1200);

  if (downloadResetTimer) {
    clearTimeout(downloadResetTimer);
  }

  if (downloadMessageTimer) {
    clearTimeout(downloadMessageTimer);
  }

  const stillDelay = isMobile() ? 4000 : 8000;
  const resetDelay = isMobile() ? 8000 : 25000;

  downloadMessageTimer = setTimeout(() => {
    downloadBtn.textContent = "Still preparing...";
    setStatus("Still preparing. Please keep this tab open.", "default", true);
  }, stillDelay);

  downloadResetTimer = setTimeout(() => {
    downloadBtn.classList.remove("loading");
    downloadBtn.textContent = DOWNLOAD_LABEL;
    setStatus("", "default", false);
  }, resetDelay);
});

window.addEventListener("focus", () => {
  if (downloadBtn.classList.contains("loading")) {
    downloadBtn.classList.remove("loading");
    downloadBtn.textContent = DOWNLOAD_LABEL;
    setStatus("", "default", false);
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
  document.getElementById("top").scrollIntoView({ behavior: "smooth", block: "start" });
});

errorModal.addEventListener("click", (event) => {
  if (event.target === errorModal) {
    closeErrorModal();
  }
});

setPreview({});
