const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i;
const PALETTE = [
  "#ff2f6d", "#ffb300", "#00e5a0", "#3da5ff",
  "#b44dff", "#ff7a29", "#22d3ee", "#a3e635"
];

const $ = (s) => document.querySelector(s);
let audio = new Audio();
audio.preload = "metadata";
audio.volume = 0.8;

let sources = [];
let srcIndex = 0;
let tracks = [];
let current = -1;
let shuffle = false;
let repeat = 0;
let accent = PALETTE[0];
let seeking = false;

let actx = null;
let analyser = null;
let freqData = null;
let webaudioOK = true;
let watchdogArmed = false;

const NFFT = 2048;
const BARS = 48;
let decodeCtx = null;
let fetchBlocked = false;
const hann = new Float32Array(NFFT);
for (let i = 0; i < NFFT; i++) {
  hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (NFFT - 1)));
}
const fftRe = new Float32Array(NFFT);
const fftIm = new Float32Array(NFFT);
const barVals = new Float32Array(BARS);
const tmpBars = new Float32Array(BARS);

const els = {
  index: $("#trackIndex"),
  mode: $("#modeLabel"),
  title: $("#trackTitle"),
  meta: $("#trackMeta"),
  viz: $("#viz"),
  seek: $("#seek"),
  cur: $("#timeCur"),
  dur: $("#timeDur"),
  play: $("#playBtn"),
  prev: $("#prevBtn"),
  next: $("#nextBtn"),
  shuf: $("#shufBtn"),
  rep: $("#repBtn"),
  load: $("#loadBtn"),
  fileInput: $("#fileInput"),
  vol: $("#volume"),
  cassette: $("#cassette"),
  list: $("#playlist"),
  count: $("#playlistCount"),
  sources: $("#sources"),
};

function fmt(t) {
  if (!isFinite(t)) return "--:--";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function cleanName(file) {
  return file.replace(AUDIO_EXT, "").replace(/[_]+/g, " ");
}

function applyAccent() {
  let next;
  do {
    next = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  } while (next === accent && PALETTE.length > 1);
  accent = next;
  document.documentElement.style.setProperty("--accent", accent);
}

function updateMode() {
  const parts = [];
  if (shuffle) parts.push("SHUFFLE");
  if (repeat === 1) parts.push("REPEAT ALL");
  if (repeat === 2) parts.push("REPEAT ONE");
  els.mode.textContent = parts.length ? parts.join(" + ") : "NORMAL";
  els.shuf.classList.toggle("active", shuffle);
  els.rep.classList.toggle("active", repeat !== 0);
  els.rep.textContent = repeat === 0 ? "REP OFF" : repeat === 1 ? "REP ALL" : "REP ONE";
}

function syncActiveSource() {
  const s = sources[srcIndex];
  if (s) {
    s.tracks = tracks;
    s.current = current;
  }
}

function selectSource(i) {
  if (!sources[i] || i === srcIndex) return;
  syncActiveSource();
  audio.pause();
  audio.removeAttribute("src");
  try { audio.load(); } catch (e) {}
  seeking = false;
  srcIndex = i;
  tracks = sources[i].tracks;
  current = sources[i].current;
  els.cur.textContent = "00:00";
  els.dur.textContent = "--:--";
  els.seek.value = 0;
  renderSources();
  renderPlaylist();
  setNowPlayingUI();
}

function renderSources() {
  els.sources.innerHTML = "";
  if (!sources.length) return;
  sources.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "btn tiny" + (i === srcIndex ? " active" : "");
    b.textContent = s.label;
    b.title = s.label + " (" + s.tracks.length + " songs)";
    b.addEventListener("click", () => selectSource(i));
    els.sources.appendChild(b);
  });
}

function sourceLabel(fileList) {
  const rel = fileList[0] && fileList[0].webkitRelativePath;
  if (rel && rel.includes("/")) {
    return rel.split("/")[0].toUpperCase().slice(0, 16);
  }
  return "LOADED FILES";
}

function renderPlaylist() {
  els.list.innerHTML = "";
  if (!tracks.length) {
    const li = document.createElement("li");
    li.className = "empty-row";
    li.textContent = "NO TRACKS LOADED";
    els.list.appendChild(li);
  }
  tracks.forEach((t, i) => {
    const li = document.createElement("li");
    if (i === current) li.classList.add("current");

    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(i + 1).padStart(2, "0");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t.name;

    const dur = document.createElement("span");
    dur.className = "dur";
    dur.textContent = t.dur ? fmt(t.dur) : "--:--";

    li.append(num, name, dur);
    li.addEventListener("click", () => play(i));
    els.list.appendChild(li);
  });
  els.count.textContent = tracks.length + " SONGS";
}

function refreshCurrentRow() {
  [...els.list.children].forEach((li, i) => {
    li.classList.toggle("current", i === current);
    const d = tracks[i] && tracks[i].dur;
    if (d && li.querySelector(".dur")) li.querySelector(".dur").textContent = fmt(d);
  });
}

function initAudioGraph() {
  if (actx || !webaudioOK) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const src = actx.createMediaElementSource(audio);
    analyser = actx.createAnalyser();
    analyser.fftSize = 512;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    analyser.connect(actx.destination);
  } catch (e) {
    actx = null;
    analyser = null;
  }
}

function sampleSum() {
  if (!analyser || !freqData) return -1;
  analyser.getByteFrequencyData(freqData);
  let sum = 0;
  for (let i = 0; i < freqData.length; i++) sum += freqData[i];
  return sum;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + half] * cr - im[i + k + half] * ci;
        const bi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + half] = ar - br;
        im[i + k + half] = ai - bi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function spectrumFromPCM(pcm, time, out) {
  const sr = pcm.sr;
  const data = pcm.data;
  const start = Math.floor(time * sr) - (NFFT >> 1);
  for (let i = 0; i < NFFT; i++) {
    const idx = start + i;
    fftRe[i] = idx >= 0 && idx < data.length ? data[idx] * hann[i] : 0;
    fftIm[i] = 0;
  }
  fft(fftRe, fftIm);
  const minF = 40;
  const maxF = Math.min(15000, sr / 2);
  const nyqBin = NFFT >> 1;
  for (let b = 0; b < BARS; b++) {
    const f0 = minF * Math.pow(maxF / minF, b / BARS);
    const f1 = minF * Math.pow(maxF / minF, (b + 1) / BARS);
    let b0 = Math.max(1, Math.floor((f0 / sr) * NFFT));
    let b1 = Math.max(b0 + 1, Math.ceil((f1 / sr) * NFFT));
    if (b1 > nyqBin) b1 = nyqBin;
    let peak = 0;
    for (let k = b0; k < b1; k++) {
      const m = Math.sqrt(fftRe[k] * fftRe[k] + fftIm[k] * fftIm[k]);
      if (m > peak) peak = m;
    }
    out[b] = Math.min(1, peak / 45);
  }
}

function getDecodeCtx() {
  if (!decodeCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    decodeCtx = new AC();
  }
  return decodeCtx;
}

async function ensurePCM(t) {
  if (!t || t.pcm !== undefined) return;
  t.pcm = null;
  try {
    let buf;
    if (t.file) {
      buf = await t.file.arrayBuffer();
    } else {
      if (fetchBlocked && location.protocol === "file:") return;
      buf = await fetch(t.url).then((r) => r.arrayBuffer());
    }
    const ab = await getDecodeCtx().decodeAudioData(buf);
    const out = new Float32Array(ab.length);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < ab.length; i++) out[i] += d[i] / ab.numberOfChannels;
    }
    t.pcm = { data: out, sr: ab.sampleRate };
  } catch (e) {
    if (!t.file) fetchBlocked = true;
    t.pcm = null;
  }
  const withPcm = tracks.filter((x) => x.pcm);
  if (withPcm.length > 6) {
    tracks.forEach((x) => {
      if (x !== tracks[current]) x.pcm = undefined;
    });
  }
}

function rebuildPlainAudio() {
  webaudioOK = false;
  analyser = null;
  freqData = null;
  if (actx) {
    try { actx.close(); } catch (e) {}
    actx = null;
  }
  const old = audio;
  const src = old.src;
  const time = old.currentTime || 0;
  const wasPlaying = !old.paused;
  old.pause();
  old.removeAttribute("src");
  try { old.load(); } catch (e) {}
  const el = new Audio();
  el.preload = "metadata";
  el.volume = parseFloat(els.vol.value);
  audio = el;
  bindMedia(el);
  el.addEventListener(
    "loadedmetadata",
    () => {
      try { el.currentTime = time; } catch (e) {}
    },
    { once: true }
  );
  el.src = src;
  if (wasPlaying) el.play().catch(() => {});
}

function armWatchdog() {
  if (!webaudioOK || !analyser || watchdogArmed) return;
  watchdogArmed = true;
  setTimeout(() => {
    if (!analyser) return (watchdogArmed = false);
    const s1 = sampleSum();
    const c1 = audio.currentTime;
    setTimeout(() => {
      watchdogArmed = false;
      if (!analyser || !webaudioOK) return;
      const s2 = sampleSum();
      const c2 = audio.currentTime;
      if (!audio.paused && !audio.ended && c2 > c1 + 0.15 && s1 === 0 && s2 === 0) {
        rebuildPlainAudio();
      }
    }, 700);
  }, 800);
}

function play(i) {
  if (!tracks.length) return;
  current = ((i % tracks.length) + tracks.length) % tracks.length;
  applyAccent();
  audio.src = tracks[current].url;
  initAudioGraph();
  if (actx && actx.state === "suspended") actx.resume();
  ensurePCM(tracks[current]);
  audio.play().catch(() => {});
}

function togglePlay() {
  if (!tracks.length) return;
  if (current === -1) return play(0);
  if (audio.paused) {
    if (!audio.getAttribute("src")) return play(current);
    initAudioGraph();
    if (actx && actx.state === "suspended") actx.resume();
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

function nextTrack(auto = false) {
  if (!tracks.length) return;
  if (shuffle && tracks.length > 1) {
    let n;
    do {
      n = Math.floor(Math.random() * tracks.length);
    } while (n === current);
    return play(n);
  }
  if (auto && repeat === 0 && current === tracks.length - 1) {
    audio.pause();
    audio.currentTime = 0;
    return;
  }
  play(current + 1);
}

function prevTrack() {
  if (!tracks.length) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  play(current - 1);
}

function setNowPlayingUI() {
  const t = tracks[current];
  if (!t) {
    els.index.textContent = "--/--";
    els.title.textContent = "INSERT TUNES";
    els.meta.textContent = "drop audio files or hit LOAD FOLDER";
    document.title = "JUKEBOX";
    return;
  }
  els.index.textContent =
    String(current + 1).padStart(2, "0") + "/" + String(tracks.length).padStart(2, "0");
  els.title.textContent = t.name;
  els.meta.textContent =
    t.ext.slice(1).toUpperCase() +
    " AUDIO" +
    (fetchBlocked && !t.file ? " \u00B7 DROP FOLDER FOR LIVE BARS" : "");
  document.title = (audio.paused ? "" : "\u25B6 ") + t.name + " — JUKEBOX";
}

function addFiles(fileList) {
  const files = [...fileList].filter((f) => AUDIO_EXT.test(f.name));
  if (!files.length) return;
  syncActiveSource();
  const t = files.map((f) => ({
    name: cleanName(f.name),
    ext: "." + f.name.split(".").pop().toLowerCase(),
    url: URL.createObjectURL(f),
    file: f,
    dur: null,
  }));
  sources.push({ label: sourceLabel(files), tracks: t, current: -1 });
  srcIndex = sources.length - 1;
  tracks = t;
  current = -1;
  renderSources();
  renderPlaylist();
  play(0);
}

els.play.addEventListener("click", togglePlay);
els.next.addEventListener("click", () => nextTrack(false));
els.prev.addEventListener("click", prevTrack);

els.shuf.addEventListener("click", () => {
  shuffle = !shuffle;
  updateMode();
});

els.rep.addEventListener("click", () => {
  repeat = (repeat + 1) % 3;
  updateMode();
});

els.load.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});

els.vol.addEventListener("input", () => {
  audio.volume = parseFloat(els.vol.value);
});

els.seek.addEventListener("pointerdown", () => (seeking = true));
window.addEventListener("pointerup", () => (seeking = false));
els.seek.addEventListener("input", () => {
  if (isFinite(audio.duration)) {
    audio.currentTime = (parseFloat(els.seek.value) / 100) * audio.duration;
  }
});

function bindMedia(el) {
  el.addEventListener("loadedmetadata", () => {
    els.dur.textContent = fmt(el.duration);
    if (tracks[current]) {
      tracks[current].dur = el.duration;
      refreshCurrentRow();
    }
  });

  el.addEventListener("timeupdate", () => {
    els.cur.textContent = fmt(el.currentTime);
    if (!seeking && isFinite(el.duration) && el.duration > 0) {
      els.seek.value = (el.currentTime / el.duration) * 100;
    }
  });

  el.addEventListener("play", () => {
    els.play.textContent = "PAUSE";
    els.cassette.classList.add("playing");
    setNowPlayingUI();
    refreshCurrentRow();
    armWatchdog();
  });

  el.addEventListener("pause", () => {
    els.play.textContent = "PLAY";
    els.cassette.classList.remove("playing");
  });

  el.addEventListener("ended", () => {
    if (repeat === 2) {
      el.currentTime = 0;
      el.play().catch(() => {});
    } else {
      nextTrack(true);
    }
  });
}

bindMedia(audio);

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input")) return;
  if (e.code === "Space") {
    e.preventDefault();
    togglePlay();
  } else if (e.code === "ArrowRight") {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
  } else if (e.code === "ArrowLeft") {
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  } else if (e.code === "KeyN") {
    nextTrack(false);
  } else if (e.code === "KeyP") {
    prevTrack();
  }
});

["dragenter", "dragover"].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  })
);

["dragleave", "drop"].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
  })
);

window.addEventListener("drop", (e) => {
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

const canvas = els.viz;
const ctx2d = canvas.getContext("2d");

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
}
window.addEventListener("resize", sizeCanvas);

function draw() {
  requestAnimationFrame(draw);
  const w = canvas.width;
  const h = canvas.height;
  ctx2d.fillStyle = "#111111";
  ctx2d.fillRect(0, 0, w, h);

  if (analyser && freqData) {
    analyser.getByteFrequencyData(freqData);
    const step = Math.floor(freqData.length / BARS);
    const bw = w / BARS;
    for (let i = 0; i < BARS; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += freqData[i * step + j];
      const target = sum / step / 255;
      barVals[i] = Math.max(target, barVals[i] * 0.82);
      const bh = Math.max(3, barVals[i] * h * 0.95);
      ctx2d.fillStyle = accent;
      ctx2d.fillRect(i * bw + bw * 0.15, h - bh, bw * 0.7, bh);
    }
    return;
  }

  const playing = !audio.paused && !audio.ended && current !== -1;
  const t = performance.now() / 160;
  const tr = tracks[current];
  const livePcm = playing && tr && tr.pcm;

  if (livePcm) spectrumFromPCM(livePcm, audio.currentTime, tmpBars);

  const bw = w / BARS;
  for (let i = 0; i < BARS; i++) {
    let target = 0;
    if (livePcm) {
      target = tmpBars[i];
    } else if (playing) {
      target =
        0.45 * Math.abs(Math.sin(t + i * 0.55)) +
        0.35 * Math.abs(Math.sin(t * 0.63 + i * 1.7)) +
        0.2 * Math.random();
    }
    barVals[i] = Math.max(target, barVals[i] * 0.82);
    const bh = Math.max(3, barVals[i] * h * 0.95);
    ctx2d.fillStyle = accent;
    ctx2d.fillRect(i * bw + bw * 0.15, h - bh, bw * 0.7, bh);
  }
}

function pruneMissing(list) {
  if (location.protocol === "file:") return Promise.resolve(list);
  return Promise.all(
    list.map((t) =>
      fetch(t.url, { method: "HEAD" })
        .then((r) => (r.ok ? t : null))
        .catch(() => t)
    )
  ).then((out) => out.filter(Boolean));
}

function boot() {
  let libTracks = [];
  if (typeof MANIFEST !== "undefined" && Array.isArray(MANIFEST)) {
    libTracks = MANIFEST.filter((f) => AUDIO_EXT.test(f)).map((f) => ({
      name: cleanName(f),
      ext: "." + f.split(".").pop().toLowerCase(),
      url: "Music/" + f.split("/").map(encodeURIComponent).join("/"),
      dur: null,
    }));
  }
  sources = [{ label: "MUSIC LIB", tracks: libTracks, current: -1 }];
  srcIndex = 0;
  tracks = libTracks;
  current = -1;
  applyAccent();
  updateMode();
  sizeCanvas();
  renderSources();
  renderPlaylist();
  setNowPlayingUI();
  draw();
  pruneMissing(libTracks).then((kept) => {
    if (
      kept.length === libTracks.length ||
      srcIndex !== 0 ||
      current !== -1 ||
      audio.getAttribute("src")
    ) {
      return;
    }
    sources[0].tracks = kept;
    tracks = kept;
    renderPlaylist();
    setNowPlayingUI();
  });
}

boot();
