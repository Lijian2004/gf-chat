/* ============ 元素引用 ============ */
const messagesEl = document.getElementById("messages");
const emptyStateEl = document.getElementById("empty-state");
const formEl = document.getElementById("composer-form");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const resetBtn = document.getElementById("reset-btn");

const setupScreen = document.getElementById("setup-screen");
const nameInput = document.getElementById("name-input");
const startBtn = document.getElementById("start-btn");
const personalityCards = document.querySelectorAll(".personality-card");

const brandNameEl = document.getElementById("brand-name");
const brandSubEl = document.getElementById("brand-sub");
const gfEmojiEl = document.getElementById("gf-emoji");
const gfLabelEl = document.getElementById("gf-label");
const gfDescEl = document.getElementById("gf-desc");
const chatStatusEl = document.getElementById("chat-status");
const headerResetBtn = document.getElementById("header-reset-btn");
const voiceBtn = document.getElementById("voice-btn");
const micBtn = document.getElementById("mic-btn");
const setupLogoEl = document.getElementById("setup-logo");
const loginOverlayEl = document.getElementById("login-overlay");
const loginPasswordEl = document.getElementById("login-password");
const loginBtnEl = document.getElementById("login-btn");
const loginErrorEl = document.getElementById("login-error");
const locationChip = document.getElementById("location-chip");
const locationEditorEl = document.getElementById("location-editor");
const locationInput = document.getElementById("location-input");
const locationSaveBtn = document.getElementById("location-save-btn");
const locationAutoBtn = document.getElementById("location-auto-btn");
const locationStatusEl = document.getElementById("location-status");

/* 性格元数据（与后端 PERSONALITIES 保持一致，用于前端展示） */
const PERSONALITY_META = {
  gentle: { label: "温柔", emoji: "🌷", desc: "轻声细语，治愈你的每一天" },
  tsundere: { label: "傲娇", emoji: "😤", desc: "口是心非，藏不住对你的喜欢" },
  aloof: { label: "高冷", emoji: "❄️", desc: "话少可靠，偶尔流露温柔" },
  sharp: { label: "犀利", emoji: "⚡", desc: "一针见血，聪明爱吐槽" },
  grumpy: { label: "暴躁", emoji: "🔥", desc: "脾气来得快去得快，其实很在意你" },
  shy: { label: "害羞", emoji: "🌸", desc: "容易脸红，需要你主动一点" },
};

/* ============ 状态 ============ */
const history = []; // 完整对话历史 [{ role, content }]
let gfName = "";
let gfPersonality = "gentle";
let greetingText = ""; // 开场白（作为上下文随请求发送，让模型衔接自然）
let isStreaming = false;
let controller = null;

/* localStorage 持久化：刷新页面不丢对话 */
const STORAGE_KEYS = {
  name: "gf_name",
  personality: "gf_personality",
  history: "gf_history",
  greeting: "gf_greeting",
  voice: "gf_voice",
  voicePersona: "gf_voice_persona",
  location: "gf_location",
};
const MAX_SAVED_HISTORY = 60;

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.history,
      JSON.stringify(history.slice(-MAX_SAVED_HISTORY))
    );
    if (greetingText) {
      localStorage.setItem(STORAGE_KEYS.greeting, greetingText);
    }
  } catch (e) {
    /* 存储不可用时静默降级 */
  }
}

function clearSavedConversation() {
  greetingText = "";
  localStorage.removeItem(STORAGE_KEYS.history);
  localStorage.removeItem(STORAGE_KEYS.greeting);
}

/* ============ 工具函数 ============ */
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 轻量 Markdown 渲染：代码块、行内代码、粗体、斜体、链接、换行
function renderMarkdown(md) {
  const codeBlocks = [];
  const inlineCodes = [];

  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.push({ lang, code });
    return `\u0000CODE${i - 1}\u0000`;
  });

  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = inlineCodes.push(code);
    return `\u0000IC${i - 1}\u0000`;
  });

  text = escapeHtml(text);

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  text = text.replace(/\u0000IC(\d+)\u0000/g, (_, i) =>
    "<code>" + escapeHtml(inlineCodes[i]) + "</code>"
  );
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
    const { lang, code } = codeBlocks[i];
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
    return (
      `<pre><div class="code-head">${langLabel}</div>` +
      `<code>${escapeHtml(code)}</code></pre>`
    );
  });

  return text.replace(/\n/g, "<br>");
}

/* 智能滚动：用户正在翻看历史时不强制拉到底部 */
function isNearBottom() {
  return (
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120
  );
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function showEmpty(show) {
  emptyStateEl.style.display = show ? "flex" : "none";
}

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

function setStreamingUI(streaming) {
  sendBtn.classList.toggle("is-streaming", streaming);
  sendBtn.setAttribute("aria-label", streaming ? "停止" : "发送");
}

// 头像图片（放在 static/avatar.png；加载失败时自动回退到性格 emoji）
const AVATAR_URL = "/static/avatar.png";

function createAvatar() {
  const meta = PERSONALITY_META[gfPersonality] || PERSONALITY_META.gentle;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  const img = document.createElement("img");
  img.className = "avatar-img";
  img.alt = meta.label;
  img.src = AVATAR_URL;
  img.onerror = () => {
    avatar.innerHTML = `<span class="avatar-emoji">${meta.emoji}</span>`;
  };
  avatar.appendChild(img);
  return avatar;
}

// 把头像图片注入某个容器（侧边栏人设、开场 logo 等），加载失败时回退到 emoji
function injectAvatar(el, emojiFallback, label) {
  if (!el) return;
  const img = document.createElement("img");
  img.className = "avatar-img";
  img.alt = label || "";
  img.src = AVATAR_URL;
  img.onerror = () => {
    el.textContent = emojiFallback || "";
  };
  el.replaceChildren(img);
}

/* ============ 消息渲染 ============ */
function createMessage(role) {
  const row = document.createElement("div");
  row.className = `message message--${role}`;

  if (role === "assistant") {
    row.appendChild(createAvatar());
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  row.appendChild(bubble);

  messagesEl.appendChild(row);
  return bubble;
}

function addUserMessage(text) {
  const bubble = createMessage("user");
  bubble.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
  scrollToBottom(true);
}

/* 刷新页面后恢复历史消息到 DOM */
function restoreMessage(m) {
  if (m.role === "user") {
    const bubble = createMessage("user");
    bubble.innerHTML = escapeHtml(m.content).replace(/\n/g, "<br>");
  } else {
    const bubble = createMessage("assistant");
    bubble.innerHTML = renderMarkdown(m.content);
  }
}

function addAssistantPlaceholder() {
  const bubble = createMessage("assistant");
  bubble.innerHTML =
    '<span class="typing"><span></span><span></span><span></span></span>';
  scrollToBottom(true);
  return bubble;
}

function updateBubble(bubble, text) {
  bubble.innerHTML = renderMarkdown(text);
}

/* ============ 语音播报（edge-tts 神经网络语音 + 浏览器兜底） ============ */
let voiceEnabled = true;
let voicePersona = "gentle";
let selectedVoice = null; // 浏览器语音（仅兜底用）
let currentAudio = null;  // { audio, url }
let voicePersonas = [];

// 把 Markdown 清洗成适合朗读的纯文本
function textForSpeech(md) {
  return (md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*#_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 优先选中文女声（仅兜底用）
function pickVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const zh = voices.filter((v) => (v.lang || "").toLowerCase().startsWith("zh"));
  const femaleHints = /xiaoxiao|huihui|yaoyao|xiaoyi|zhiling|晓晓|慧慧|瑶瑶|晓伊/i;
  const female =
    zh.find((v) => femaleHints.test(v.name)) ||
    zh.find((v) => femaleHints.test(v.voiceURI || ""));
  return female || zh.find((v) => (v.lang || "").toLowerCase() === "zh-cn") || zh[0] || null;
}

function stopAudio() {
  if (currentAudio) {
    try { currentAudio.audio.pause(); } catch (e) {}
    try { URL.revokeObjectURL(currentAudio.url); } catch (e) {}
    currentAudio = null;
  }
}

// 兜底：网络 TTS 失败时退回浏览器语音合成
function speakFallback(text) {
  if (!("speechSynthesis" in window)) return;
  const clean = textForSpeech(text);
  if (!clean) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "zh-CN";
    u.rate = 1.05;
    u.pitch = 1.05;
    if (selectedVoice) u.voice = selectedVoice;
    speechSynthesis.speak(u);
  } catch (e) { /* 忽略 */ }
}

async function speak(text) {
  if (!voiceEnabled) return;
  // 错误 / 停止提示不朗读
  if (/\[请求失败\]|\[错误\]|（已停止）/.test(text || "")) return;
  const clean = textForSpeech(text);
  if (!clean) return;

  stopAudio();

  try {
    const res = await axios.post(
      "/api/tts",
      { text: clean, voice: voicePersona },
      { responseType: "blob", timeout: 30000 }
    );
    const blob = res.data;
    if (!blob || (blob.size != null && blob.size === 0)) throw new Error("empty audio");
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const handle = { audio, url };
    currentAudio = handle;
    const cleanup = () => {
      try { URL.revokeObjectURL(url); } catch (e) {}
      if (currentAudio === handle) currentAudio = null;
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    await audio.play();
  } catch (e) {
    stopAudio();
    speakFallback(text);
  }
}

function updateVoiceUI() {
  voiceBtn.classList.toggle("is-on", voiceEnabled);
  voiceBtn.setAttribute("aria-pressed", String(voiceEnabled));
  const label = voiceEnabled ? "关闭语音播报" : "开启语音播报";
  voiceBtn.setAttribute("aria-label", label);
  voiceBtn.title = label;
}

function initVoices() {
  // 浏览器语音仅作兜底，缺失也不影响 edge-tts 主方案
  if (!("speechSynthesis" in window)) return;
  const load = () => { selectedVoice = pickVoice(); };
  load();
  if (speechSynthesis.addEventListener) {
    speechSynthesis.addEventListener("voiceschanged", load);
  }
}

async function loadVoicePersonas() {
  try {
    const res = await axios.get("/api/tts/voices");
    voicePersonas = res.data || [];
  } catch (e) {
    voicePersonas = [];
  }
  renderVoicePicker();
}

function renderVoicePicker() {
  const container = document.getElementById("voice-picker");
  if (!container) return;
  container.innerHTML = "";
  voicePersonas.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-chip" + (p.key === voicePersona ? " selected" : "");
    btn.dataset.voice = p.key;
    btn.textContent = `${p.emoji} ${p.label}`;
    btn.addEventListener("click", () => {
      if (p.key !== voicePersona) {
        voicePersona = p.key;
        localStorage.setItem(STORAGE_KEYS.voicePersona, p.key);
        renderVoicePicker();
      }
    });
    container.appendChild(btn);
  });
}

/* ============ 语音输入（录音 → ASR） ============ */
let micStream = null;
let micRecorder = null;
let micChunks = [];
let isRecording = false;

function _writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function _encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  _writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  _writeStr(view, 8, "WAVE");
  _writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  _writeStr(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("当前浏览器不支持麦克风录音，请用 Chrome / Edge。");
    return false;
  }
  if (typeof MediaRecorder === "undefined") {
    alert("当前浏览器不支持录音，请用 Chrome / Edge。");
    return false;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("无法访问麦克风，请检查浏览器权限后重试。");
    return false;
  }

  // 选一个浏览器支持的录制格式
  let mimeType = "";
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) {
      mimeType = c;
      break;
    }
  }

  micChunks = [];
  micRecorder = mimeType ? new MediaRecorder(micStream, { mimeType }) : new MediaRecorder(micStream);
  micRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) micChunks.push(e.data);
  };
  micRecorder.start();

  isRecording = true;
  micBtn.classList.add("is-recording");
  micBtn.title = "停止并发送";
  return true;
}

function _resample(samples, fromRate, toRate) {
  return new Promise((resolve, reject) => {
    try {
      const len = Math.ceil((samples.length * toRate) / fromRate);
      const ctx = new OfflineAudioContext(1, len, toRate);
      const buf = ctx.createBuffer(1, samples.length, fromRate);
      buf.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      ctx.startRendering()
        .then((rendered) => resolve(rendered.getChannelData(0)))
        .catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function _decodeToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctor = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctor();
  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close();
  }
  let samples = audioBuffer.getChannelData(0);
  let rate = audioBuffer.sampleRate;
  if (rate !== 16000) {
    try {
      samples = await _resample(samples, rate, 16000);
      rate = 16000;
    } catch (e) { /* 保持原采样率 */ }
  }
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return { blob: _encodeWav(samples, rate), peak };
}

async function stopRecording() {
  if (!isRecording) return null;
  isRecording = false;
  micBtn.classList.remove("is-recording");
  micBtn.title = "语音输入";

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    micRecorder.onstop = finish;
    try {
      micRecorder.stop();
    } catch (e) {
      finish();
    }
    setTimeout(finish, 3000); // 兜底
  });

  micStream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(micChunks, { type: micRecorder.mimeType || "audio/webm" });
  if (!blob.size) return null;

  try {
    const { blob: wavBlob, peak } = await _decodeToWav(blob);
    if (peak < 0.005) return { silent: true };
    return wavBlob;
  } catch (e) {
    // 解码失败（极少见）：按无数据处理
    return null;
  }
}

async function transcribeAndSend(blob) {
  micBtn.disabled = true;
  micBtn.classList.add("is-transcribing");
  try {
    const res = await axios.post("/api/asr?format=wav", blob, {
      headers: { "Content-Type": "application/octet-stream" },
      timeout: 30000,
    });
    const text = ((res.data && res.data.text) || "").trim();
    if (text) {
      inputEl.value = text;
      autoResize();
      sendMessage();
    } else {
      _flashPlaceholder("没听清，再说一遍？", 2000);
    }
  } catch (e) {
    const msg =
      (e.response && e.response.data && e.response.data.error) ||
      e.message ||
      "识别失败";
    _flashPlaceholder(`语音识别失败：${msg}`, 3000);
  } finally {
    micBtn.disabled = false;
    micBtn.classList.remove("is-transcribing");
  }
}

let _placeholderTimer = null;
function _flashPlaceholder(msg, ms) {
  const orig = inputEl.placeholder;
  inputEl.placeholder = msg;
  if (_placeholderTimer) clearTimeout(_placeholderTimer);
  _placeholderTimer = setTimeout(() => {
    inputEl.placeholder = orig;
  }, ms);
}

async function handleMicClick() {
  if (isRecording) {
    const result = await stopRecording();
    if (!result) return;
    if (result.silent) {
      _flashPlaceholder("没录到声音，请检查麦克风是否可用", 3000);
      return;
    }
    await transcribeAndSend(result);
  } else {
    await startRecording();
  }
}

/* ============ 城市定位与天气 ============ */
/* 定位优先级：本地缓存 → IP 定位（静默）→ 浏览器定位（需授权）→ 手动输入城市。
   城市和实时天气随每条消息发给后端，注入她的 system prompt，
   这样她就能自然地提醒你降温添衣、下雨带伞。 */
let locationInfo = null; // { city, lat, lon }
let weatherText = "";    // 完整天气描述（发给后端注入人设）
let weatherShort = "";   // 短描述（侧边栏 chip 展示用）
let locBusy = false;

function renderLocation() {
  if (locationInfo && locationInfo.city && weatherShort) {
    locationChip.textContent = `📍 ${locationInfo.city} · ${weatherShort}`;
  } else if (locationInfo && locationInfo.city) {
    locationChip.textContent = `📍 ${locationInfo.city}`;
  } else if (locationInfo && weatherShort) {
    locationChip.textContent = `📍 ${weatherShort}`;
  } else {
    locationChip.textContent = "📍 设置城市";
  }
}

function saveLocationLocal() {
  try {
    localStorage.setItem(STORAGE_KEYS.location, JSON.stringify(locationInfo));
  } catch (e) { /* 存储不可用时静默降级 */ }
}

/* 查询天气并更新展示；locationInfo 决定用坐标还是城市名请求 */
async function fetchWeather() {
  if (!locationInfo) return false;
  const params = {};
  if (locationInfo.lat != null && locationInfo.lon != null) {
    params.lat = locationInfo.lat;
    params.lon = locationInfo.lon;
    if (locationInfo.city) params.name = locationInfo.city;
  } else if (locationInfo.city) {
    params.city = locationInfo.city;
  } else {
    return false;
  }
  try {
    const res = await axios.get("/api/weather", { params, timeout: 9000 });
    const d = res.data || {};
    if (!d.weather_text) return false;
    locationInfo = {
      city: d.city || locationInfo.city || "",
      lat: d.lat,
      lon: d.lon,
    };
    weatherText = d.weather_text;
    weatherShort = d.short || "";
    saveLocationLocal();
    renderLocation();
    return true;
  } catch (e) {
    return false;
  }
}

/* 浏览器定位（需用户授权），包装成 Promise */
function getBrowserCoords(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("浏览器不支持定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { timeout: timeoutMs, maximumAge: 10 * 60 * 1000, enableHighAccuracy: false }
    );
  });
}

async function locateByIP() {
  const res = await axios.get("/api/location/ip", { timeout: 7000 });
  const d = res.data || {};
  if (!d.city || d.lat == null) return false;
  locationInfo = { city: d.city, lat: d.lat, lon: d.lon };
  saveLocationLocal();
  await fetchWeather();
  return true;
}

async function locateByBrowser() {
  const c = await getBrowserCoords();
  locationInfo = { city: "", lat: c.lat, lon: c.lon };
  await fetchWeather(); // 服务端反查城市名
  return !!(locationInfo && locationInfo.city);
}

/* 完整自动定位流程：IP → 浏览器定位 */
async function detectLocation() {
  if (locBusy) return;
  locBusy = true;
  locationAutoBtn.disabled = true;
  locationStatusEl.classList.remove("error");
  locationStatusEl.textContent = "定位中…";
  let ok = false;
  try { ok = await locateByIP(); } catch (e) { /* 忽略，继续浏览器定位 */ }
  if (!ok) {
    try { ok = await locateByBrowser(); } catch (e) { /* 授权拒绝等 */ }
  }
  if (ok) {
    locationStatusEl.textContent = "";
    locationEditorEl.classList.add("hidden");
  } else {
    locationChip.textContent = "📍 设置城市";
    locationStatusEl.textContent = "自动定位不可用，试试手动输入城市名";
    locationStatusEl.classList.add("error");
  }
  locationAutoBtn.disabled = false;
  locBusy = false;
}

/* 手动保存城市 */
async function saveManualCity() {
  const name = locationInput.value.trim();
  if (!name || locBusy) return;
  locBusy = true;
  locationSaveBtn.disabled = true;
  locationStatusEl.classList.remove("error");
  locationStatusEl.textContent = "查询中…";
  try {
    const res = await axios.get("/api/weather", { params: { city: name }, timeout: 9000 });
    const d = res.data || {};
    locationInfo = { city: d.city || name, lat: d.lat, lon: d.lon };
    weatherText = d.weather_text || "";
    weatherShort = d.short || "";
    saveLocationLocal();
    renderLocation();
    locationStatusEl.textContent = "";
    locationEditorEl.classList.add("hidden");
  } catch (e) {
    const msg =
      (e.response && e.response.data && e.response.data.error) ||
      "查询失败，请稍后再试";
    locationStatusEl.textContent = msg;
    locationStatusEl.classList.add("error");
  } finally {
    locationSaveBtn.disabled = false;
    locBusy = false;
  }
}

/* 初始化定位：有缓存先用缓存，否则自动定位；之后每 10 分钟刷新天气 */
async function initLocation() {
  const saved = localStorage.getItem(STORAGE_KEYS.location);
  if (saved) {
    try {
      const d = JSON.parse(saved);
      if (d && (d.city || d.lat != null)) locationInfo = d;
    } catch (e) { /* 数据损坏则重新定位 */ }
  }
  if (locationInfo) {
    renderLocation();
    fetchWeather();
  } else {
    detectLocation();
  }
  setInterval(() => { if (locationInfo) fetchWeather(); }, 10 * 60 * 1000);
}

locationChip.addEventListener("click", () => {
  const nowHidden = locationEditorEl.classList.toggle("hidden");
  if (!nowHidden) {
    locationInput.value = (locationInfo && locationInfo.city) || "";
    locationStatusEl.textContent = "";
    locationStatusEl.classList.remove("error");
    locationInput.focus();
  }
});

locationSaveBtn.addEventListener("click", saveManualCity);
locationAutoBtn.addEventListener("click", detectLocation);
locationInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveManualCity();
  }
});

/* 消息请求携带的位置数据（供后端注入人设） */
function locationPayload() {
  if (locationInfo && (locationInfo.city || weatherText)) {
    return { city: locationInfo.city || "", weather_text: weatherText };
  }
  return null;
}

/* ============ 流式请求 ============ */
async function streamReply(payload) {
  const bubble = addAssistantPlaceholder();
  let acc = "";
  isStreaming = true;
  controller = new AbortController();
  setStreamingUI(true);

  try {
    const res = await axios.post("/api/chat", payload, {
      responseType: "text",
      signal: controller.signal,
      onDownloadProgress: (e) => {
        const xhr = e.currentTarget || e.target;
        const full = (xhr.responseText != null ? xhr.responseText : xhr.response) || "";
        if (full.length > acc.length) {
          acc = full;
          updateBubble(bubble, acc);
          scrollToBottom();
        }
      },
    });

    const finalText = res.data || "";
    if (finalText !== acc) {
      acc = finalText;
      updateBubble(bubble, acc);
    }
  } catch (err) {
    if (axios.isCancel(err) || (err && err.code === "ERR_CANCELED")) {
      acc += "\n\n_（已停止）_";
      updateBubble(bubble, acc);
    } else {
      const msg =
        (err.response && err.response.data && err.response.data.error) ||
        err.message ||
        "网络错误";
      acc += `\n\n[请求失败] ${msg}`;
      bubble.classList.add("bubble--error");
      updateBubble(bubble, acc);
    }
  } finally {
    isStreaming = false;
    controller = null;
    setStreamingUI(false);
    scrollToBottom();
  }

  return acc;
}

/* ============ 发送消息 ============ */
async function sendMessage(userText) {
  if (isStreaming) return;

  const text = (userText ?? inputEl.value).trim();
  if (!text) return;

  showEmpty(false);
  addUserMessage(text);
  history.push({ role: "user", content: text });

  inputEl.value = "";
  autoResize();

  const payload = {
    messages: history.slice(),
    name: gfName,
    personality: gfPersonality,
  };
  if (greetingText) payload.greeting_text = greetingText;
  const loc = locationPayload();
  if (loc) payload.location = loc;

  const reply = await streamReply(payload);
  if (reply.trim()) {
    history.push({ role: "assistant", content: reply });
    saveState();
    speak(reply);
  }
  inputEl.focus();
}

async function startGreeting() {
  // 开场白仅作展示，不写入 history（避免后续请求以 assistant 开头导致 API 报错）；
  // 通过 greeting_text 作为上下文传给后端，保证模型知道自己说过什么
  const payload = {
    greeting: true,
    messages: [],
    name: gfName,
    personality: gfPersonality,
  };
  const loc = locationPayload();
  if (loc) payload.location = loc;
  const reply = await streamReply(payload);
  if (reply.trim()) {
    greetingText = reply;
    saveState();
    speak(reply);
  }
}

function stopGeneration() {
  if (controller) controller.abort();
}

/* ============ 设定流程 ============ */
function updateIdentity() {
  const meta = PERSONALITY_META[gfPersonality] || PERSONALITY_META.gentle;
  brandNameEl.textContent = gfName || "AI 女友";
  brandSubEl.textContent = "你的 AI 女友";
  injectAvatar(gfEmojiEl, meta.emoji, meta.label);
  injectAvatar(setupLogoEl, "💞", "头像");
  gfLabelEl.textContent = meta.label;
  gfDescEl.textContent = meta.desc;
  chatStatusEl.innerHTML = gfName
    ? `💞 与 ${escapeHtml(gfName)} 恋爱中`
    : "💞 恋爱中";
  document.title = gfName ? `${gfName} · 你的 AI 女友` : "AI 女友 · 你的专属陪伴";
}

function checkStartEnabled() {
  startBtn.disabled = !(nameInput.value.trim() && gfPersonality);
}

async function startSetup() {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }

  gfName = name;
  localStorage.setItem("gf_name", name);
  localStorage.setItem("gf_personality", gfPersonality);

  updateIdentity();
  setupScreen.classList.add("hidden");

  // 清空旧对话
  history.length = 0;
  clearSavedConversation();
  messagesEl.querySelectorAll(".message").forEach((n) => n.remove());
  showEmpty(false);
  inputEl.focus();

  await startGreeting();
}

/* ============ 事件绑定 ============ */
personalityCards.forEach((card) => {
  card.addEventListener("click", () => {
    gfPersonality = card.dataset.personality;
    personalityCards.forEach((c) => c.classList.toggle("selected", c === card));
    checkStartEnabled();
  });
});

nameInput.addEventListener("input", checkStartEnabled);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    startSetup();
  }
});
startBtn.addEventListener("click", startSetup);

function openSetup() {
  if (isStreaming) return;
  nameInput.value = gfName || "";
  personalityCards.forEach((c) =>
    c.classList.toggle("selected", c.dataset.personality === gfPersonality)
  );
  checkStartEnabled();
  setupScreen.classList.remove("hidden");
  nameInput.focus();
}

resetBtn.addEventListener("click", openSetup);
headerResetBtn.addEventListener("click", openSetup);

voiceBtn.addEventListener("click", () => {
  voiceEnabled = !voiceEnabled;
  if (!voiceEnabled) {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    stopAudio();
  }
  localStorage.setItem(STORAGE_KEYS.voice, voiceEnabled ? "1" : "0");
  updateVoiceUI();
});

micBtn.addEventListener("click", handleMicClick);

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  if (isStreaming) stopGeneration();
  else sendMessage();
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (isStreaming) stopGeneration();
    else sendMessage();
  }
});

inputEl.addEventListener("input", autoResize);

/* 动态获取后端模型名，展示在侧边栏徽章 */
async function fetchModelBadge() {
  const badge = document.querySelector(".model-badge");
  if (!badge) return;
  try {
    const res = await axios.get("/api/health");
    if (res.data && res.data.model) badge.textContent = res.data.model;
  } catch (e) {
    /* 忽略，保留默认文案 */
  }
}

/* ============ 访问密码登录 ============ */
async function checkAuth() {
  try {
    const res = await axios.get("/api/auth");
    return !!(res.data && res.data.authed);
  } catch (e) {
    return false;
  }
}

async function doLogin() {
  const pw = loginPasswordEl.value.trim();
  if (!pw) {
    loginErrorEl.textContent = "请输入密码";
    return;
  }
  loginBtnEl.disabled = true;
  try {
    await axios.post("/api/login", { password: pw });
    loginOverlayEl.classList.add("hidden");
    loginPasswordEl.value = "";
    loginErrorEl.textContent = "";
  } catch (e) {
    loginErrorEl.textContent = "密码错误，请重试";
  } finally {
    loginBtnEl.disabled = false;
  }
}

loginBtnEl.addEventListener("click", doLogin);
loginPasswordEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});

/* ============ 初始化 ============ */
(function init() {
  // 登录态检查：未登录则弹密码框
  checkAuth().then((authed) => {
    if (!authed) loginOverlayEl.classList.remove("hidden");
  });

  const savedName = localStorage.getItem(STORAGE_KEYS.name) || "";
  const savedPersonality = localStorage.getItem(STORAGE_KEYS.personality) || "gentle";
  if (PERSONALITY_META[savedPersonality]) {
    gfPersonality = savedPersonality;
  }
  greetingText = localStorage.getItem(STORAGE_KEYS.greeting) || "";

  // 恢复历史对话
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || "[]");
    if (Array.isArray(saved)) {
      saved.forEach((m) => {
        if (
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim()
        ) {
          history.push(m);
          restoreMessage(m);
        }
      });
    }
  } catch (e) {
    localStorage.removeItem(STORAGE_KEYS.history);
  }

  nameInput.value = savedName;
  personalityCards.forEach((c) =>
    c.classList.toggle("selected", c.dataset.personality === gfPersonality)
  );

  updateIdentity();
  checkStartEnabled();

  // 语音播报设置（默认开启）
  if (localStorage.getItem(STORAGE_KEYS.voice) === "0") voiceEnabled = false;
  voicePersona = localStorage.getItem(STORAGE_KEYS.voicePersona) || "gentle";
  initVoices();
  updateVoiceUI();
  loadVoicePersonas();

  initLocation();

  fetchModelBadge();

  if (savedName && history.length) {
    // 有历史对话：直接回到聊天界面
    setupScreen.classList.add("hidden");
    showEmpty(false);
    scrollToBottom(true);
    inputEl.focus();
  } else {
    showEmpty(history.length === 0);
    nameInput.focus();
  }
})();
