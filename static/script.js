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
const callOverlayEl = document.getElementById("call-overlay");
const callTimerEl = document.getElementById("call-timer");
const callAvatarEl = document.getElementById("call-avatar");
const callAvatarWrapEl = document.getElementById("call-avatar-wrap");
const callNameEl = document.getElementById("call-name");
const callStatusEl = document.getElementById("call-status");
const callTranscriptEl = document.getElementById("call-transcript");
const callMuteBtn = document.getElementById("call-mute-btn");
const callHangupBtn = document.getElementById("call-hangup-btn");
const callBtnHeader = document.getElementById("call-btn");

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

// 兜底：网络 TTS 失败时退回浏览器语音合成（Promise，播完或失败后 resolve）
function speakFallback(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) { resolve(); return; }
    const clean = textForSpeech(text);
    if (!clean) { resolve(); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = "zh-CN";
      u.rate = 1.05;
      u.pitch = 1.05;
      if (selectedVoice) u.voice = selectedVoice;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
      setTimeout(finish, 20000); // 兜底
    } catch (e) { resolve(); }
  });
}

/* 共享：请求豆包 TTS，返回音频 Blob */
async function fetchTTSBlob(clean) {
  const res = await axios.post(
    "/api/tts",
    { text: clean, voice: voicePersona },
    { responseType: "blob", timeout: 30000 }
  );
  return res.data;
}

/* 共享：播放音频 Blob（主聊天与通话共用 currentAudio 句柄） */
function playAudioBlob(blob) {
  return new Promise((resolve) => {
    let done = false;
    let url = null;
    let audio = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (currentAudio && currentAudio.audio === audio) currentAudio = null;
      if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
      resolve();
    };
    try {
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      currentAudio = { audio, url };
      audio.onended = finish;
      audio.onerror = finish;
      const p = audio.play();
      if (p && p.catch) p.catch(finish);
      setTimeout(finish, 120000); // 绝对兜底
    } catch (e) { finish(); }
  });
}

/* ============ 主聊天分句朗读：边流式边合成播放，不等全文 ============ */
/* 旧逻辑等整条回复生成完再整段合成，文字先出、语音要再等两三秒；
   现在第一句一到就开口，且当前句播放时预取下一句，句间零停顿。 */
let chatSpeechQueue = [];
let chatSpeechBusy = false;
let chatSpeechPrefetch = null; // { text, promise }
let chatSpeechGen = 0;         // 重置代次：打断后丢弃在途请求的播放

function chatSpeechReset() {
  chatSpeechGen++;
  chatSpeechQueue = [];
  chatSpeechPrefetch = null;
  stopAudio();
}

function chatSpeechEnqueue(sentences) {
  if (!voiceEnabled || !sentences || !sentences.length) return;
  chatSpeechQueue.push(...sentences);
  pumpChatSpeech();
}

async function pumpChatSpeech() {
  if (!voiceEnabled || chatSpeechBusy) return;
  const sentence = chatSpeechQueue.shift();
  if (!sentence) return;
  const gen = chatSpeechGen;
  chatSpeechBusy = true;
  let clean = "";
  try {
    clean = textForSpeech(sentence);
    if (clean) {
      let blobPromise;
      if (chatSpeechPrefetch && chatSpeechPrefetch.text === clean) {
        blobPromise = chatSpeechPrefetch.promise; // 命中预取，直接播放
        chatSpeechPrefetch = null;
      } else {
        blobPromise = fetchTTSBlob(clean);
      }
      // 当前句播放期间预取下一句的音频，消除句间停顿
      const nextClean = textForSpeech(chatSpeechQueue[0] || "");
      chatSpeechPrefetch = nextClean
        ? { text: nextClean, promise: fetchTTSBlob(nextClean).catch(() => null) }
        : null;
      const blob = await blobPromise;
      if (gen !== chatSpeechGen) return; // 已被打断（新消息/停止/关语音）
      if (!blob || (blob.size != null && blob.size === 0)) throw new Error("empty audio");
      await playAudioBlob(blob);
    }
  } catch (e) {
    chatSpeechPrefetch = null;
    if (gen === chatSpeechGen && voiceEnabled && clean) await speakFallback(clean);
  } finally {
    chatSpeechBusy = false;
  }
  if (gen === chatSpeechGen) pumpChatSpeech();
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

/* 选一个浏览器支持的录制格式（语音输入与通话共用） */
function pickRecorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
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

  const mimeType = pickRecorderMime();
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

/* 初始化定位：有缓存先用缓存，否则自动定位；之后每 10 分钟刷新天气。
   可安全重复调用（登录成功后会补跑一次），定时器只注册一份 */
let locationTimerStarted = false;
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
  } else if (!locBusy) {
    detectLocation();
  }
  if (!locationTimerStarted) {
    locationTimerStarted = true;
    setInterval(() => { if (locationInfo) fetchWeather(); }, 10 * 60 * 1000);
  }
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

/* ============ 语音通话 ============ */
/* 类似豆包的通话模式：全屏通话界面 + 浏览器端静音检测（VAD）自动断句。
   对话循环：录音 → ASR 识别 → 大模型（通话模式，回复短而口语）→ 分句 TTS 边生成边播 → 继续聆听。
   通话内容实时写入主聊天记录，挂断后可在聊天界面看到，她也记得。 */
const CALL_VAD_MIN = 0.01;        // VAD 阈值下限
const CALL_VAD_MAX = 0.05;        // VAD 阈值上限
const CALL_SILENCE_MS = 1400;     // 静音多久判定「说完了」
const CALL_MAX_UTTER_MS = 20000;  // 单段录音上限
const CALL_POLL_MS = 100;         // VAD 轮询间隔
const CALL_TRANSCRIPT_MAX = 8;    // 通话字幕保留条数

let callActive = false;
let callState = "idle"; // idle | connecting | listening | recognizing | thinking | speaking | muted
let callMuted = false;
let callMicStream = null;
let callAudioCtx = null;
let callAnalyser = null;
let callVadTimer = null;
let callRecorder = null;
let callChunks = [];
let callUtterStart = 0;
let callSpeechSeen = false;
let callSilenceSince = 0;
let callNoiseFloor = 0.004; // 自适应噪声底（EMA），说话阈值 = max(下限, 噪声底×3)
let callStartTs = 0;
let callTimerInterval = null;
let callController = null;
let callStreamDone = true;
let callSentenceQueue = [];
let callTtsBusy = false;
let callTtsPrefetch = null; // { text, promise } 预取的下一句音频
let callStatusTimer = null;

function callVadThreshold() {
  return Math.min(CALL_VAD_MAX, Math.max(CALL_VAD_MIN, callNoiseFloor * 3));
}

function setCallState(state, statusText) {
  callState = state;
  if (statusText != null) callStatusEl.textContent = statusText;
  callAvatarWrapEl.classList.toggle("is-speaking", state === "speaking");
  callAvatarWrapEl.classList.toggle("is-listening", state === "listening");
  callAvatarWrapEl.classList.toggle("is-muted", state === "muted");
}

function flashCallStatus(msg, ms = 2000) {
  callStatusEl.textContent = msg;
  clearTimeout(callStatusTimer);
  callStatusTimer = setTimeout(() => {
    const map = {
      connecting: "正在连接…",
      listening: "正在聆听…",
      recognizing: "正在识别…",
      thinking: "思考中…",
      speaking: "正在说话…",
      muted: "已静音",
    };
    if (map[callState]) callStatusEl.textContent = map[callState];
  }, ms);
}

function addCallBubble(role, html) {
  const div = document.createElement("div");
  div.className = `call-msg call-msg--${role}`;
  div.innerHTML = html;
  callTranscriptEl.appendChild(div);
  callTranscriptEl.scrollTop = callTranscriptEl.scrollHeight;
  while (callTranscriptEl.children.length > CALL_TRANSCRIPT_MAX) {
    callTranscriptEl.removeChild(callTranscriptEl.firstChild);
  }
  return div;
}

function updateCallTimer() {
  const s = Math.floor((Date.now() - callStartTs) / 1000);
  callTimerEl.textContent =
    String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

/* ============ 通话入口 / 挂断 ============ */
async function startCall() {
  if (callActive) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
    alert("当前浏览器不支持语音通话，请用较新的 Chrome / Edge。");
    return;
  }

  callActive = true;
  callMuted = false;
  callMuteBtn.classList.remove("is-muted");
  callMuteBtn.title = "静音";
  callSentenceQueue = [];
  callTtsBusy = false;
  callTtsPrefetch = null;
  callStreamDone = true;
  callNoiseFloor = 0.004;
  chatSpeechReset(); // 清空主聊天的朗读队列并停止播放，避免抢音频

  callOverlayEl.classList.remove("hidden");
  callTranscriptEl.innerHTML = "";
  callTimerEl.textContent = "00:00";

  const meta = PERSONALITY_META[gfPersonality] || PERSONALITY_META.gentle;
  callNameEl.textContent = gfName || "AI 女友";
  injectAvatar(callAvatarEl, meta.emoji, meta.label);

  callStartTs = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(updateCallTimer, 1000);

  setCallState("connecting", "正在连接…");

  try {
    callMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    callStatusEl.textContent = "无法访问麦克风，通话结束";
    setTimeout(endCall, 1200);
    return;
  }

  // VAD：用 AnalyserNode 实时监测麦克风音量（只分析，不连输出，避免回声）
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    callAudioCtx = new Ctor();
    if (callAudioCtx.resume) callAudioCtx.resume().catch(() => {});
    const source = callAudioCtx.createMediaStreamSource(callMicStream);
    callAnalyser = callAudioCtx.createAnalyser();
    callAnalyser.fftSize = 1024;
    source.connect(callAnalyser);
  } catch (e) {
    callAnalyser = null;
  }
  clearInterval(callVadTimer);
  callVadTimer = setInterval(vadTick, CALL_POLL_MS);

  // 问候语播放完毕后（音频队列排空事件）自动进入聆听状态
  await callGreeting();
}

function endCall() {
  if (!callActive) {
    callOverlayEl.classList.add("hidden");
    return;
  }
  callActive = false;
  if (callController) {
    try { callController.abort(); } catch (e) { /* 忽略 */ }
  }
  callController = null;
  callSentenceQueue = [];
  callTtsBusy = false;
  callTtsPrefetch = null;
  stopCallAudio();
  if (callVadTimer) { clearInterval(callVadTimer); callVadTimer = null; }
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
  if (callRecorder && callRecorder.state !== "inactive") {
    try { callRecorder.stop(); } catch (e) { /* 忽略 */ }
  }
  callRecorder = null;
  if (callMicStream) {
    callMicStream.getTracks().forEach((t) => t.stop());
    callMicStream = null;
  }
  if (callAudioCtx) {
    try { callAudioCtx.close(); } catch (e) { /* 忽略 */ }
    callAudioCtx = null;
    callAnalyser = null;
  }
  clearTimeout(callStatusTimer);
  setCallState("idle");
  callOverlayEl.classList.add("hidden");
  scrollToBottom();
  inputEl.focus();
}

/* ============ 聆听与静音检测（VAD） ============ */
function startListening() {
  if (!callActive || callState === "listening") return;
  if (currentAudio || callTtsBusy) return; // 她还在说话，等音频播完（由排空事件触发）
  if (callMuted) {
    setCallState("muted", "已静音");
    return;
  }
  callSpeechSeen = false;
  callSilenceSince = 0;
  callUtterStart = Date.now();
  startCallRecorder();
  setCallState("listening", "正在聆听…");
}

function callRms() {
  if (!callAnalyser) return 0;
  const buf = new Float32Array(callAnalyser.fftSize);
  callAnalyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function vadTick() {
  if (!callActive || callMuted || callState !== "listening") return;
  const now = Date.now();
  const level = callRms();
  if (level > callVadThreshold()) {
    callSpeechSeen = true;
    callSilenceSince = 0;
  } else {
    if (callSpeechSeen) {
      if (!callSilenceSince) callSilenceSince = now;
      if (now - callSilenceSince >= CALL_SILENCE_MS) {
        stopUtterance();
        return;
      }
    }
    callNoiseFloor = callNoiseFloor * 0.9 + level * 0.1; // 静音帧持续更新噪声底
  }
  if (now - callUtterStart >= CALL_MAX_UTTER_MS) {
    stopUtterance();
  }
}

function startCallRecorder() {
  if (!callMicStream) return;
  callChunks = [];
  const mimeType = pickRecorderMime();
  try {
    callRecorder = mimeType
      ? new MediaRecorder(callMicStream, { mimeType })
      : new MediaRecorder(callMicStream);
  } catch (e) {
    callRecorder = null;
    return;
  }
  callRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) callChunks.push(e.data);
  };
  callRecorder.start();
}

function stopCallRecorder(rec) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    rec.onstop = finish;
    try { rec.stop(); } catch (e) { finish(); }
    setTimeout(finish, 2000); // 兜底
  });
}

async function stopUtterance(discard = false) {
  if (callState !== "listening") return;
  setCallState("recognizing", discard ? "" : "正在识别…");
  const rec = callRecorder;
  callRecorder = null;
  if (!rec || rec.state === "inactive") {
    if (!discard) startListening();
    return;
  }
  await stopCallRecorder(rec);
  if (discard || !callActive) return;

  const blob = new Blob(callChunks, { type: rec.mimeType || "audio/webm" });
  callChunks = [];
  if (!blob.size) {
    startListening();
    return;
  }

  try {
    const { blob: wavBlob, peak } = await _decodeToWav(blob);
    if (peak < 0.005 || !callSpeechSeen) {
      startListening(); // 误触发 / 纯噪声，继续聆听
      return;
    }
    const res = await axios.post("/api/asr?format=wav", wavBlob, {
      headers: { "Content-Type": "application/octet-stream" },
      timeout: 30000,
    });
    const text = ((res.data && res.data.text) || "").trim();
    if (!text) {
      flashCallStatus("没听清，再说说？");
      startListening();
      return;
    }
    await handleCallTurn(text);
  } catch (e) {
    const msg =
      (e.response && e.response.data && e.response.data.error) ||
      e.message || "识别失败";
    flashCallStatus(`语音识别失败：${msg}`, 3000);
    if (callActive) startListening();
  }
}

/* ============ 通话中的一轮对话 ============ */
async function handleCallTurn(text) {
  addCallBubble("user", escapeHtml(text).replace(/\n/g, "<br>"));
  addUserMessage(text); // 同步写入主聊天界面，挂断后可见
  history.push({ role: "user", content: text });

  const payload = {
    messages: history.slice(),
    name: gfName,
    personality: gfPersonality,
    call: true,
  };
  if (greetingText) payload.greeting_text = greetingText;
  const loc = locationPayload();
  if (loc) payload.location = loc;

  await runCallReply(payload);
}

async function callGreeting() {
  if (!callActive) return;
  const payload = {
    greeting: true,
    messages: [],
    name: gfName,
    personality: gfPersonality,
    call: true,
  };
  const loc = locationPayload();
  if (loc) payload.location = loc;
  await runCallReply(payload, { greeting: true }); // 字幕由 runCallReply 内部渲染
}

/* 把流式文本按句切分：返回 { out: 完整句子列表, rest: 未成句的尾巴 } */
function extractSentences(buffer, flush = false) {
  const out = [];
  let start = 0;
  const re = /[。！？!?；;\n～~…]/g;
  let m;
  while ((m = re.exec(buffer))) {
    const seg = buffer.slice(start, m.index + 1).trim();
    // 过滤纯标点碎片（如「……」）
    if (seg && /[^\s。！？!?；;～~…，,、.]/.test(seg)) out.push(seg);
    start = m.index + 1;
  }
  const rest = buffer.slice(start);
  if (flush && rest.trim()) {
    out.push(rest.trim());
    return { out, rest: "" };
  }
  return { out, rest };
}

/* 流式获取她的回复：边流式接收边分句送 TTS 队列播放 */
async function runCallReply(payload, opts = {}) {
  const isGreeting = !!opts.greeting;
  let acc = "";
  let pending = "";
  let chatBubble = null;
  const transcriptBubble = addCallBubble("assistant", "");

  if (!isGreeting) {
    chatBubble = createMessage("assistant");
    showEmpty(false);
  }

  callStreamDone = false;
  callController = new AbortController();
  setCallState("thinking", "思考中…");

  const pushText = (full) => {
    acc = full;
    if (chatBubble) updateBubble(chatBubble, acc);
    transcriptBubble.innerHTML = renderMarkdown(acc);
    callTranscriptEl.scrollTop = callTranscriptEl.scrollHeight;
  };

  try {
    const res = await axios.post("/api/chat", payload, {
      responseType: "text",
      signal: callController.signal,
      onDownloadProgress: (e) => {
        const xhr = (e && (e.currentTarget || e.target)) || null;
        const full = ((xhr && xhr.responseText != null ? xhr.responseText : xhr && xhr.response) || "");
        if (full.length > acc.length) {
          pending += full.slice(acc.length);
          pushText(full);
          const { out, rest } = extractSentences(pending);
          pending = rest;
          enqueueCallSentences(out);
        }
      },
    });

    const finalText = res.data || "";
    if (finalText.length > acc.length) {
      pending += finalText.slice(acc.length);
      pushText(finalText);
    }
    if (pending.trim()) {
      enqueueCallSentences([pending.trim()]);
      pending = "";
    }
  } catch (err) {
    if (axios.isCancel(err) || (err && err.code === "ERR_CANCELED")) {
      acc += "\n\n（已停止）";
    } else {
      const msg =
        (err.response && err.response.data && err.response.data.error) ||
        err.message || "网络错误";
      acc += `\n\n[请求失败] ${msg}`;
      if (chatBubble) chatBubble.classList.add("bubble--error");
    }
    if (chatBubble) updateBubble(chatBubble, acc);
  } finally {
    callController = null;
    callStreamDone = true;
    transcriptBubble.innerHTML = renderMarkdown(acc || "（未收到回复）");
    callTranscriptEl.scrollTop = callTranscriptEl.scrollHeight;
  }

  if (!isGreeting && acc.trim()) {
    history.push({ role: "assistant", content: acc });
    saveState();
  } else if (!isGreeting && !acc.trim() && chatBubble && chatBubble.parentNode) {
    chatBubble.parentNode.removeChild(chatBubble); // 空回复不留在主聊天
  }

  pumpCallTTS(); // 若音频队列已空则立即收尾，否则播完后触发
  return acc;
}

/* ============ 分句 TTS 播放队列 ============ */
function enqueueCallSentences(list) {
  if (!list.length || !callActive) return;
  callSentenceQueue.push(...list);
  pumpCallTTS();
}

async function pumpCallTTS() {
  if (!callActive || callTtsBusy) return;
  const sentence = callSentenceQueue.shift();
  if (!sentence) {
    if (callStreamDone) onCallReplyAudioDone();
    return;
  }
  callTtsBusy = true;
  await speakCallSentence(sentence);
  callTtsBusy = false;
  if (callActive) pumpCallTTS();
}

function onCallReplyAudioDone() {
  if (!callActive) return;
  startListening(); // 内部有幂等保护
}

async function speakCallSentence(text) {
  if (!callActive) return;
  setCallState("speaking", "正在说话…");
  const clean = textForSpeech(text);
  if (!clean) return;
  try {
    let blobPromise;
    if (callTtsPrefetch && callTtsPrefetch.text === clean) {
      blobPromise = callTtsPrefetch.promise; // 命中预取，直接播放
      callTtsPrefetch = null;
    } else {
      blobPromise = fetchTTSBlob(clean);
    }
    // 当前句播放期间预取下一句的音频，消除句间停顿
    const nextClean = textForSpeech(callSentenceQueue[0] || "");
    callTtsPrefetch = nextClean
      ? { text: nextClean, promise: fetchTTSBlob(nextClean).catch(() => null) }
      : null;
    const blob = await blobPromise;
    if (!callActive) return; // 等待期间已挂断，不再播放
    if (!blob || (blob.size != null && blob.size === 0)) throw new Error("empty audio");
    await playAudioBlob(blob);
  } catch (e) {
    if (!callActive) return;
    callTtsPrefetch = null;
    await speakFallback(clean); // 网络合成失败时退回浏览器语音
  }
}

function stopCallAudio() {
  stopAudio(); // 共用 currentAudio 句柄
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/* ============ 通话事件绑定 ============ */
callMuteBtn.addEventListener("click", () => {
  if (!callActive) return;
  callMuted = !callMuted;
  callMuteBtn.classList.toggle("is-muted", callMuted);
  callMuteBtn.title = callMuted ? "取消静音" : "静音";
  if (callMuted) {
    if (callState === "listening") stopUtterance(true);
    setCallState("muted", "已静音");
  } else if (currentAudio || callTtsBusy) {
    // 她还在说话：先显示说话状态，等音频播完由排空事件自动进入聆听
    setCallState("speaking", "正在说话…");
  } else {
    startListening();
  }
});

callHangupBtn.addEventListener("click", endCall);

callBtnHeader.addEventListener("click", () => {
  if (callActive) return;
  if (isStreaming) stopGeneration();
  startCall();
});

/* ============ 流式请求 ============ */
/* opts.speech: 开启后边流式接收边分句朗读（第一句一到就开口，不等全文） */
async function streamReply(payload, opts = {}) {
  const bubble = addAssistantPlaceholder();
  let acc = "";
  let pending = "";
  let spokenUpTo = 0;
  const speechOn = !!(opts.speech && voiceEnabled);
  isStreaming = true;
  controller = new AbortController();
  setStreamingUI(true);

  try {
    const res = await axios.post("/api/chat", payload, {
      responseType: "text",
      signal: controller.signal,
      onDownloadProgress: (e) => {
        const xhr = (e && (e.currentTarget || e.target)) || null;
        const full = ((xhr && xhr.responseText != null ? xhr.responseText : xhr && xhr.response) || "");
        if (full.length > acc.length) {
          acc = full;
          updateBubble(bubble, acc);
          scrollToBottom();
          if (speechOn) {
            pending += full.slice(spokenUpTo);
            spokenUpTo = full.length;
            const { out, rest } = extractSentences(pending);
            pending = rest;
            chatSpeechEnqueue(out);
          }
        }
      },
    });

    const finalText = res.data || "";
    if (finalText !== acc) {
      acc = finalText;
      updateBubble(bubble, acc);
    }
    if (speechOn) {
      // 把最后没成句的尾巴也排入朗读（错误/停止提示不读）
      pending += finalText.slice(Math.min(spokenUpTo, finalText.length));
      if (!/\[请求失败\]|\[错误\]|（已停止）/.test(finalText)) {
        const { out } = extractSentences(pending, true);
        chatSpeechEnqueue(out);
      }
    }
  } catch (err) {
    if (axios.isCancel(err) || (err && err.code === "ERR_CANCELED")) {
      chatSpeechReset(); // 用户停止：打断朗读
      acc += "\n\n_（已停止）_";
      updateBubble(bubble, acc);
    } else {
      chatSpeechQueue = [];
      chatSpeechPrefetch = null;
      chatSpeechGen++;
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

  chatSpeechReset(); // 新消息打断上一条回复的朗读
  const reply = await streamReply(payload, { speech: true });
  if (reply.trim()) {
    history.push({ role: "assistant", content: reply });
    saveState();
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
  chatSpeechReset();
  const reply = await streamReply(payload, { speech: true });
  if (reply.trim()) {
    greetingText = reply;
    saveState();
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
    chatSpeechReset(); // 停止当前朗读并清空队列
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
    // 登录前页面初始化的请求（音色列表/定位）会因 401 失败，登录后补拉一次
    if (!voicePersonas.length) loadVoicePersonas();
    initLocation();
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
