const form = document.getElementById("reelForm");
const reelUrlInput = document.getElementById("reelUrl");
const statusEl = document.getElementById("status");
const previewMedia = document.getElementById("previewMedia");
const reelTitle = document.getElementById("reelTitle");
const audioName = document.getElementById("audioName");
const downloadBtn = document.getElementById("downloadBtn");
const copyBtn = document.getElementById("copyBtn");
const fineprint = document.getElementById("fineprint");
const errorModal = document.getElementById("errorModal");
const closeModal = document.getElementById("closeModal");
const retryBtn = document.getElementById("retryBtn");
const modalMessage = document.getElementById("modalMessage");

const setStatus = (message, tone = "default") => {
  statusEl.textContent = message;
  statusEl.style.color =
    tone === "error" ? "#b42318" : tone === "success" ? "#0f766e" : "#2f7b7b";
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
  if (data.previewUrl) {
    const video = document.createElement("video");
    video.src = data.previewUrl;
    video.controls = true;
    video.playsInline = true;
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

  if (data.mp3Url) {
    downloadBtn.href = data.mp3Url;
    downloadBtn.setAttribute("download", data.downloadName || "reel-audio.mp3");
    downloadBtn.classList.remove("disabled");
    fineprint.textContent = "Ready to download.";
  } else {
    downloadBtn.href = "#";
    downloadBtn.removeAttribute("download");
    downloadBtn.classList.add("disabled");
    fineprint.textContent = "Download will start once we fetch the audio file.";
  }

  copyBtn.disabled = !data.mp3Url;
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
  setStatus("Fetching reel details...");
  downloadBtn.classList.add("disabled");

  try {
    const response = await fetch(`/api/reel?url=${encodeURIComponent(url)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Reel lookup failed");
    }
    setPreview(data);
    setStatus("Reel loaded.", "success");
  } catch (error) {
    const message =
      error.message || "Could not load reel. Please try again after some time.";
    setStatus(message, "error");
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

copyBtn.addEventListener("click", async () => {
  if (downloadBtn.classList.contains("disabled")) {
    return;
  }
  try {
    await navigator.clipboard.writeText(downloadBtn.href);
    setStatus("Audio link copied.", "success");
  } catch {
    setStatus("Clipboard access failed.", "error");
  }
});

closeModal.addEventListener("click", closeErrorModal);
retryBtn.addEventListener("click", () => {
  closeErrorModal();
  form.requestSubmit();
});

errorModal.addEventListener("click", (event) => {
  if (event.target === errorModal) {
    closeErrorModal();
  }
});

setPreview({});
