/* 聊天主页面：流式对话 + 分句朗读 + 语音输入 + 通话模式 + 定位天气 + 访问密码 */
const {
  PERSONALITY_META,
  STORAGE_KEYS,
  MAX_SAVED_HISTORY,
  extractSentences,
  markdownToNodes,
  loadState,
} = require("../../utils/util");
const api = require("../../utils/api");
const { createSpeechQueue } = require("../../utils/tts");
const asr = require("../../utils/asr");

/* 通话 VAD 参数（与 Web 版一致） */
const CALL_VAD_MIN = 0.01;
const CALL_VAD_MAX = 0.05;
const CALL_SILENCE_MS = 1400;
const CALL_MAX_UTTER_MS = 20000;
const CALL_TRANSCRIPT_MAX = 8;

function ensureRecordPermission() {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success: (s) => {
        if (s.authSetting["scope.record"]) return resolve();
        wx.authorize({ scope: "scope.record", success: resolve, fail: reject });
      },
      fail: reject,
    });
  });
}

Page({
  data: {
    name: "",
    personality: "gentle",
    meta: PERSONALITY_META.gentle,
    messages: [], // [{ key, role, text?, nodes?, error?, pending? }]
    lastKey: 0,
    empty: true,
    input: "",
    isStreaming: false,
    voiceOn: true,
    model: "",
    locationText: "📍 定位中…",
    // 登录
    needLogin: false,
    loginPwd: "",
    loginError: "",
    // 语音输入
    recording: false,
    // 通话
    call: false,
    callState: "idle",
    callStatus: "",
    callTimer: "00:00",
    muted: false,
    transcript: [],
    lastTKey: 0,
  },

  onLoad(options) {
    const st = loadState();
    if (!st.name) {
      wx.reLaunch({ url: "/pages/setup/setup" });
      return;
    }
    this.history = st.history;
    this.greetingText = st.greeting;
    this.locationInfo = st.location;
    this.weatherText = "";
    this.weatherRefreshTimer = null;
    this.voices = [];
    this.streamTask = null;
    this.callTask = null;

    /* 朗读队列：聊天与通话各一，共用 createSpeechQueue 引擎 */
    this.chatSpeech = createSpeechQueue({
      canSpeak: () => this.data.voiceOn,
      voice: () => wx.getStorageSync(STORAGE_KEYS.voicePersona) || "gentle",
    });
    this.callSpeech = createSpeechQueue({
      canSpeak: () => this.callActive === true,
      voice: () => wx.getStorageSync(STORAGE_KEYS.voicePersona) || "gentle",
      onSpeak: () => this.setCallState("speaking"),
      onDrained: () => {
        if (this.callStreamDone && this.callActive) this.startListening();
      },
    });

    /* 通话状态 */
    this.callActive = false;
    this.callMuted = false;
    this.callStreamDone = true;
    this.callNoiseFloor = 0.004;
    this.callSpeechSeen = false;
    this.callSilenceSince = 0;
    this.callUtterStart = 0;
    this.callStartTs = 0;
    this.callTimerInt = null;
    this.callStatusTimer = null;

    /* 渲染历史 */
    const messages = [];
    let seq = 0;
    for (const m of this.history) {
      messages.push(
        m.role === "assistant"
          ? { key: seq, role: "assistant", nodes: markdownToNodes(m.content) }
          : { key: seq, role: "user", text: m.content }
      );
      seq++;
    }
    this.msgSeq = seq;

    this.setData({
      name: st.name,
      personality: st.personality,
      meta: PERSONALITY_META[st.personality],
      voiceOn: st.voice,
      messages,
      empty: messages.length === 0,
      lastKey: seq - 1,
    });
    wx.setNavigationBarTitle({ title: st.name });

    api.fetchHealth()
      .then((d) => this.setData({ model: (d && d.model) || "" }))
      .catch(() => {});

    /* 登录态检查：未登录弹密码框，已登录拉取鉴权数据 */
    api.checkAuth()
      .then((authed) => {
        if (authed) {
          this.bootstrapAfterAuth();
          this.maybeGreeting(options);
        } else {
          this.pendingGreeting = options;
          this.setData({ needLogin: true });
        }
      })
      .catch(() => this.setData({ needLogin: true }));
  },

  /* 首次进入/新设定时生成开场白（须等登录态就绪，避免 401） */
  maybeGreeting(options) {
    const fresh = options && options.fresh === "1";
    if (fresh || (!this.history.length && !this.greetingText)) this.startGreeting();
  },

  onUnload() {
    this.chatSpeech.reset();
    if (this.callActive) this.endCall();
    clearTimeout(this.weatherRefreshTimer);
  },

  /* ============ 登录 ============ */
  onLoginPwd(e) {
    this.setData({ loginPwd: e.detail.value, loginError: "" });
  },

  async doLogin() {
    const pw = this.data.loginPwd.trim();
    if (!pw) {
      this.setData({ loginError: "请输入密码" });
      return;
    }
    try {
      await api.login(pw);
      this.setData({ needLogin: false, loginPwd: "", loginError: "" });
      this.bootstrapAfterAuth();
      if (this.pendingGreeting) {
        const options = this.pendingGreeting;
        this.pendingGreeting = null;
        this.maybeGreeting(options);
      }
    } catch (e) {
      this.setData({ loginError: "密码错误，请重试" });
    }
  },

  /* 登录态就绪后拉取需要鉴权的初始化数据 */
  bootstrapAfterAuth() {
    if (!this.voices.length) {
      api.fetchVoices()
        .then((list) => { this.voices = list || []; })
        .catch(() => {});
    }
    this.initLocation();
  },

  /* ============ 定位与天气 ============ */
  async initLocation() {
    if (this.locationInfo && (this.locationInfo.city || this.locationInfo.lat != null)) {
      this.renderLocation();
      this.fetchWeather();
    } else {
      this.detectLocation();
    }
  },

  async detectLocation() {
    /* 优先 IP 定位（静默），失败回退浏览器定位（wx.getLocation 需授权） */
    try {
      const d = await api.locationByIP();
      if (d && d.city && d.lat != null) {
        this.locationInfo = { city: d.city, lat: d.lat, lon: d.lon };
        wx.setStorageSync(STORAGE_KEYS.location, this.locationInfo);
        this.renderLocation();
        await this.fetchWeather();
        return;
      }
    } catch (e) { /* 忽略，继续 */ }
    try {
      const loc = await new Promise((resolve, reject) =>
        wx.getLocation({ type: "gcj02", success: resolve, fail: reject })
      );
      this.locationInfo = { city: "", lat: loc.latitude, lon: loc.longitude };
      await this.fetchWeather(); // 服务端反查城市名
      if (this.locationInfo && this.locationInfo.city) return;
      throw new Error("no city");
    } catch (e) {
      this.setData({ locationText: "📍 点此设置城市" });
    }
  },

  onLocationTap() {
    wx.showActionSheet({
      itemList: ["重新自动定位", "手动输入城市"],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.locationInfo = null;
          this.setData({ locationText: "📍 定位中…" });
          this.detectLocation();
        } else {
          wx.showModal({
            title: "输入城市名",
            editable: true,
            placeholderText: "如：杭州",
            success: (r) => {
              if (r.confirm && r.content && r.content.trim()) this.saveManualCity(r.content.trim());
            },
          });
        }
      },
    });
  },

  async saveManualCity(name) {
    this.setData({ locationText: "📍 查询中…" });
    try {
      const d = await api.weather({ city: name });
      this.locationInfo = { city: d.city || name, lat: d.lat, lon: d.lon };
      this.weatherText = d.weather_text || "";
      wx.setStorageSync(STORAGE_KEYS.location, this.locationInfo);
      this.renderLocation();
      this.scheduleWeatherRefresh(d.refresh_after);
    } catch (e) {
      this.setData({ locationText: "📍 查询失败，点此重试" });
    }
  },

  async fetchWeather() {
    const info = this.locationInfo;
    if (!info) return;
    const params = {};
    if (info.lat != null && info.lon != null) {
      params.lat = info.lat;
      params.lon = info.lon;
      if (info.city) params.name = info.city;
    } else if (info.city) {
      params.city = info.city;
    } else {
      return;
    }
    try {
      const d = await api.weather(params);
      if (!d.weather_text) return;
      this.locationInfo = { city: d.city || info.city || "", lat: d.lat, lon: d.lon };
      this.weatherText = d.weather_text;
      wx.setStorageSync(STORAGE_KEYS.location, this.locationInfo);
      this.renderLocation();
      this.scheduleWeatherRefresh(d.refresh_after);
    } catch (e) { /* 静默降级，天气只是锦上添花 */ }
  },

  /* 天气定时刷新：由后端 refresh_after（缓存 TTL）驱动 */
  scheduleWeatherRefresh(seconds) {
    clearTimeout(this.weatherRefreshTimer);
    this.weatherRefreshTimer = setTimeout(() => {
      if (this.locationInfo) this.fetchWeather();
    }, (seconds || 600) * 1000);
  },

  renderLocation() {
    const city = this.locationInfo && this.locationInfo.city;
    this.setData({ locationText: city ? `📍 ${city}` : "📍 已定位" });
  },

  /* ============ 消息渲染 ============ */
  pushMessage(m) {
    const key = this.msgSeq++;
    const msg = { key, ...m };
    this.setData({
      messages: this.data.messages.concat(msg),
      empty: false,
      lastKey: key,
    });
    return key;
  },

  patchMessage(key, patch) {
    const idx = this.data.messages.findIndex((m) => m.key === key);
    if (idx < 0) return;
    const patchData = {};
    for (const k of Object.keys(patch)) {
      patchData[`messages[${idx}].${k}`] = patch[k];
    }
    patchData.lastKey = key;
    this.setData(patchData);
  },

  dropMessage(key) {
    const messages = this.data.messages.filter((m) => m.key !== key);
    this.setData({ messages, empty: messages.length === 0 });
  },

  saveState() {
    try {
      wx.setStorageSync(STORAGE_KEYS.history, this.history.slice(-MAX_SAVED_HISTORY));
      if (this.greetingText) wx.setStorageSync(STORAGE_KEYS.greeting, this.greetingText);
    } catch (e) { /* 存储不可用时静默降级 */ }
  },

  /* ============ 发送 / 流式回复 ============ */
  buildChatPayload({ messages, greeting = false, call = false } = {}) {
    const payload = {
      messages,
      name: this.data.name,
      personality: this.data.personality,
    };
    if (greeting) payload.greeting = true;
    if (call) payload.call = true;
    if (this.greetingText) payload.greeting_text = this.greetingText;
    const info = this.locationInfo;
    if (info && (info.city || this.weatherText)) {
      payload.location = { city: info.city || "", weather_text: this.weatherText };
    }
    return payload;
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  onSend() {
    if (this.data.isStreaming) {
      this.stopGeneration();
      return;
    }
    const text = (this.data.input || "").trim();
    if (!text) return;
    this.setData({ input: "" });
    this.sendMessage(text);
  },

  stopGeneration() {
    if (this.streamTask) this.streamTask.abort();
  },

  async sendMessage(text) {
    this.history.push({ role: "user", content: text });
    this.pushMessage({ role: "user", text });
    this.chatSpeech.reset(); // 新消息打断上一条回复的朗读
    const reply = await this.streamReply(this.buildChatPayload({ messages: this.history.slice() }));
    if (reply.trim()) {
      this.history.push({ role: "assistant", content: reply });
      this.saveState();
    }
  },

  async startGreeting() {
    // 开场白仅展示，不写入 history；经 greeting_text 传给后端衔接
    this.chatSpeech.reset();
    const reply = await this.streamReply(this.buildChatPayload({ messages: [], greeting: true }));
    if (reply.trim()) {
      this.greetingText = reply;
      this.saveState();
    }
  },

  /* 流式回复（主聊天）：气泡实时渲染 Markdown，分句送朗读队列 */
  async streamReply(payload) {
    const key = this.pushMessage({ role: "assistant", nodes: [], pending: true });
    this.setData({ isStreaming: true });
    const task = api.chatStream(payload, {
      onText: (full) => this.patchMessage(key, { nodes: markdownToNodes(full), pending: false }),
      onSentence: (out) => this.chatSpeech.enqueue(out),
      onDone: (tail, full) => {
        // 最后没成句的尾巴也排入朗读（错误/停止提示不读）
        if (!/\[请求失败\]|\[错误\]|（已停止）/.test(full)) {
          const r = extractSentences(tail, true);
          this.chatSpeech.enqueue(r.out);
        }
      },
    });
    this.streamTask = task;
    const { text, canceled, err } = await task.promise;
    let finalText = text;
    if (canceled) {
      this.chatSpeech.reset(); // 用户停止：打断朗读
      finalText += "\n\n_（已停止）_";
    } else if (err) {
      this.chatSpeech.cancelPending();
      finalText += `\n\n[请求失败] ${err.message || "网络错误"}`;
    }
    this.patchMessage(key, { nodes: markdownToNodes(finalText), pending: false, error: !!err });
    this.setData({ isStreaming: false });
    this.streamTask = null;
    return finalText;
  },

  /* ============ 语音输入（点按开始 / 再点结束识别发送） ============ */
  async onMicTap() {
    if (this.data.recording) {
      this.setData({ recording: false });
      const wav = await asr.stop();
      if (!wav) {
        wx.showToast({ title: "没录到声音", icon: "none" });
        return;
      }
      try {
        const text = await api.asr(wav);
        if (text) {
          this.setData({ input: text });
          this.onSend();
        } else {
          wx.showToast({ title: "没听清，再说一遍？", icon: "none" });
        }
      } catch (e) {
        wx.showToast({ title: `识别失败：${e.message || ""}`, icon: "none" });
      }
    } else {
      try {
        await ensureRecordPermission();
      } catch (e) {
        wx.showToast({ title: "需要麦克风权限才能语音输入", icon: "none" });
        return;
      }
      this.setData({ recording: true });
      asr.start(null);
    }
  },

  /* ============ 菜单（重新设定 / 音色 / 清空对话） ============ */
  onMenu() {
    const personaLabel = (() => {
      const v = this.voices.find((x) => x.key === (wx.getStorageSync(STORAGE_KEYS.voicePersona) || "gentle"));
      return v ? `${v.emoji || ""} ${v.label}（当前）` : null;
    })();
    const items = ["重新设定名字与性格", "选择朗读音色", "清空对话记录"];
    if (personaLabel) items.splice(1, 0, personaLabel);
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const label = items[res.tapIndex];
        if (label === "重新设定名字与性格") {
          wx.reLaunch({ url: "/pages/setup/setup" });
        } else if (label === "选择朗读音色") {
          this.pickVoice();
        } else if (label === "清空对话记录") {
          this.clearConversation();
        }
        // 当前音色（无前缀选项）不做事，仅作展示
      },
    });
  },

  pickVoice() {
    if (!this.voices.length) {
      wx.showToast({ title: "音色列表还没加载好", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: this.voices.map((v) => `${v.emoji || ""} ${v.label}`),
      success: (res) => {
        const v = this.voices[res.tapIndex];
        if (v) wx.setStorageSync(STORAGE_KEYS.voicePersona, v.key);
      },
    });
  },

  clearConversation() {
    this.greetingText = "";
    this.history = [];
    wx.removeStorageSync(STORAGE_KEYS.history);
    wx.removeStorageSync(STORAGE_KEYS.greeting);
    this.chatSpeech.reset();
    this.setData({ messages: [], empty: true });
    this.startGreeting();
  },

  toggleVoice() {
    const voiceOn = !this.data.voiceOn;
    if (!voiceOn) this.chatSpeech.reset();
    wx.setStorageSync(STORAGE_KEYS.voice, voiceOn ? "1" : "0");
    this.setData({ voiceOn });
  },

  /* ============ 通话模式 ============ */
  setCallState(state, statusText) {
    const defaults = {
      connecting: "正在连接…",
      listening: "正在聆听…",
      recognizing: "正在识别…",
      thinking: "思考中…",
      speaking: "正在说话…",
      muted: "已静音",
    };
    const patch = { callState: state };
    if (statusText === undefined) statusText = defaults[state] || "";
    if (statusText != null) patch.callStatus = statusText;
    this.setData(patch);
  },

  flashCallStatus(msg, ms = 2000) {
    this.setData({ callStatus: msg });
    clearTimeout(this.callStatusTimer);
    this.callStatusTimer = setTimeout(() => {
      const defaults = {
        connecting: "正在连接…",
        listening: "正在聆听…",
        recognizing: "正在识别…",
        thinking: "思考中…",
        speaking: "正在说话…",
        muted: "已静音",
      };
      if (defaults[this.data.callState]) this.setData({ callStatus: defaults[this.data.callState] });
    }, ms);
  },

  async startCall() {
    if (this.callActive) return;
    try {
      await ensureRecordPermission();
    } catch (e) {
      wx.showToast({ title: "需要麦克风权限才能通话", icon: "none" });
      return;
    }

    this.callActive = true;
    this.callMuted = false;
    this.callStreamDone = true;
    this.callNoiseFloor = 0.004;
    this.callSpeech.cancelPending();
    this.chatSpeech.reset(); // 停止聊天朗读，避免抢音频
    this.setData({
      call: true,
      muted: false,
      callState: "connecting",
      callStatus: "正在连接…",
      callTimer: "00:00",
      transcript: [],
      lastTKey: 0,
    });

    this.callStartTs = Date.now();
    clearInterval(this.callTimerInt);
    this.callTimerInt = setInterval(() => {
      const s = Math.floor((Date.now() - this.callStartTs) / 1000);
      this.setData({
        callTimer:
          String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"),
      });
    }, 1000);

    await this.callGreeting();
  },

  endCall() {
    if (!this.callActive) {
      this.setData({ call: false });
      return;
    }
    this.callActive = false;
    if (this.callTask) this.callTask.abort();
    this.callTask = null;
    this.callSpeech.cancelPending();
    clearInterval(this.callTimerInt);
    if (this.data.callState === "listening" || this.data.callState === "recognizing") {
      asr.stop(); // 丢弃在录的音频
    }
    clearTimeout(this.callStatusTimer);
    this.setData({ call: false, callState: "idle" });
  },

  toggleMute() {
    if (!this.callActive) return;
    this.callMuted = !this.callMuted;
    this.setData({ muted: this.callMuted });
    if (this.callMuted) {
      if (this.data.callState === "listening") this.stopUtterance(true);
      this.setCallState("muted");
    } else if (this.callSpeech.isPlaying() || this.callSpeech.isBusy()) {
      // 她还在说话：等音频播完由排空事件自动进入聆听
      this.setCallState("speaking");
    } else {
      this.startListening();
    }
  },

  /* 聆听：启动录音，PCM 帧驱动 VAD 自动断句 */
  startListening() {
    if (!this.callActive || this.data.callState === "listening") return;
    if (this.callSpeech.isPlaying() || this.callSpeech.isBusy()) return; // 等她播完
    if (this.callMuted) {
      this.setCallState("muted");
      return;
    }
    this.callSpeechSeen = false;
    this.callSilenceSince = 0;
    this.callUtterStart = Date.now();
    this.setCallState("listening");
    asr.start((frame) => this.onCallFrame(frame));
  },

  onCallFrame(frame) {
    if (frame === null) {
      // 麦克风出错
      this.flashCallStatus("无法访问麦克风，通话结束", 1200);
      setTimeout(() => this.endCall(), 1200);
      return;
    }
    if (!this.callActive || this.callMuted || this.data.callState !== "listening") return;
    const now = Date.now();
    const level = asr.frameRms(frame);
    const threshold = Math.min(CALL_VAD_MAX, Math.max(CALL_VAD_MIN, this.callNoiseFloor * 3));
    if (level > threshold) {
      this.callSpeechSeen = true;
      this.callSilenceSince = 0;
    } else {
      if (this.callSpeechSeen) {
        if (!this.callSilenceSince) this.callSilenceSince = now;
        if (now - this.callSilenceSince >= CALL_SILENCE_MS) {
          this.stopUtterance();
          return;
        }
      }
      this.callNoiseFloor = this.callNoiseFloor * 0.9 + level * 0.1; // 静音帧持续更新噪声底
    }
    if (now - this.callUtterStart >= CALL_MAX_UTTER_MS) this.stopUtterance();
  },

  async stopUtterance(discard = false) {
    if (this.data.callState !== "listening") return;
    this.setCallState("recognizing", discard ? "" : undefined);
    const wav = discard ? null : await asr.stop();
    if (discard || !this.callActive) return;
    if (!wav) {
      this.startListening();
      return;
    }
    try {
      const text = await api.asr(wav);
      if (!text) {
        this.flashCallStatus("没听清，再说说？");
        this.startListening();
        return;
      }
      await this.handleCallTurn(text);
    } catch (e) {
      this.flashCallStatus(`语音识别失败：${e.message || "识别失败"}`, 3000);
      if (this.callActive) this.startListening();
    }
  },

  pushTranscript(role, text) {
    const key = this.msgSeq++;
    const item = { key, role, text };
    const transcript = this.data.transcript.concat(item);
    while (transcript.length > CALL_TRANSCRIPT_MAX) transcript.shift();
    this.setData({ transcript, lastTKey: key });
    return key;
  },

  patchTranscript(key, text) {
    const idx = this.data.transcript.findIndex((t) => t.key === key);
    if (idx < 0) return;
    this.setData({ [`transcript[${idx}].text`]: text, lastTKey: key });
  },

  async handleCallTurn(text) {
    this.pushTranscript("user", text);
    this.history.push({ role: "user", content: text });
    this.pushMessage({ role: "user", text }); // 同步写入主聊天，挂断后可见
    await this.runCallReply(this.buildChatPayload({ messages: this.history.slice(), call: true }));
  },

  async callGreeting() {
    if (!this.callActive) return;
    await this.runCallReply(this.buildChatPayload({ messages: [], greeting: true, call: true }), {
      greeting: true,
    });
  },

  /* 通话回复：字幕实时更新，分句送通话朗读队列 */
  async runCallReply(payload, opts = {}) {
    const isGreeting = !!opts.greeting;
    const tKey = this.pushTranscript("assistant", "");
    let chatKey = null;
    if (!isGreeting) {
      chatKey = this.pushMessage({ role: "assistant", nodes: [], pending: true });
    }

    this.callStreamDone = false;
    this.setCallState("thinking");
    const task = api.chatStream(payload, {
      onText: (full) => {
        if (chatKey != null) this.patchMessage(chatKey, { nodes: markdownToNodes(full), pending: false });
        this.patchTranscript(tKey, full);
      },
      onSentence: (out) => this.callSpeech.enqueue(out),
      onDone: (tail) => {
        if (tail.trim()) this.callSpeech.enqueue([tail.trim()]);
      },
    });
    this.callTask = task;
    const { text: acc, canceled, err } = await task.promise;

    let finalText = acc;
    if (canceled) finalText += "\n\n（已停止）";
    else if (err) finalText += `\n\n[请求失败] ${err.message || "网络错误"}`;
    if (chatKey != null) this.patchMessage(chatKey, { nodes: markdownToNodes(finalText), pending: false, error: !!err });
    this.patchTranscript(tKey, finalText || "（未收到回复）");
    this.callStreamDone = true;

    if (!isGreeting && acc.trim()) {
      this.history.push({ role: "assistant", content: acc });
      this.saveState();
    } else if (!isGreeting && !acc.trim() && chatKey != null) {
      this.dropMessage(chatKey); // 空回复不留在主聊天
    }

    this.callSpeech.pump(); // 若音频队列已空则立即收尾，否则播完后触发
    return acc;
  },
});
