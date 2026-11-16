/* 后端 API 封装：请求 Promise 化 + 流式聊天（enableChunked） */
const { Utf8StreamDecoder, extractSentences } = require("./util");

const app = getApp();

function request(opts) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: app.globalData.baseUrl + opts.path,
      method: opts.method || "GET",
      data: opts.data,
      header: opts.header || { "Content-Type": "application/json" },
      timeout: opts.timeout || 15000,
      responseType: opts.responseType || "text",
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject({
            statusCode: res.statusCode,
            message: (res.data && res.data.error) || `HTTP ${res.statusCode}`,
          });
        }
      },
      fail: (err) => reject({ canceled: err && /abort/i.test(err.errMsg || ""), message: (err && err.errMsg) || "网络错误" }),
    });
  });
}

/* ============ 访问密码 ============ */
function checkAuth() {
  return request({ path: "/api/auth", timeout: 8000 }).then((d) => !!(d && d.authed));
}

function login(password) {
  return request({ path: "/api/login", method: "POST", data: { password } });
}

/* ============ 健康检查 / 音色 ============ */
function fetchHealth() {
  return request({ path: "/api/health", timeout: 8000 });
}

function fetchVoices() {
  return request({ path: "/api/tts/voices" });
}

/* ============ TTS / ASR ============ */
/* 合成一句语音，返回 MP3 ArrayBuffer；promise 上挂 abort() 用于取消预取 */
function tts(clean, voice) {
  let task = null;
  const promise = new Promise((resolve, reject) => {
    task = wx.request({
      url: app.globalData.baseUrl + "/api/tts",
      method: "POST",
      data: { text: clean, voice },
      header: { "Content-Type": "application/json" },
      responseType: "arraybuffer",
      timeout: 30000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else reject(new Error(`TTS HTTP ${res.statusCode}`));
      },
      fail: (err) => reject(new Error((err && err.errMsg) || "TTS 失败")),
    });
  });
  promise.abort = () => { try { task.abort(); } catch (e) {} };
  return promise;
}

/* 上传 WAV（ArrayBuffer）做语音识别，返回文本 */
function asr(wavBuffer) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: app.globalData.baseUrl + "/api/asr?format=wav",
      method: "POST",
      data: wavBuffer,
      header: { "Content-Type": "application/octet-stream" },
      timeout: 30000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(((res.data && res.data.text) || "").trim());
        } else {
          reject(new Error((res.data && res.data.error) || `ASR HTTP ${res.statusCode}`));
        }
      },
      fail: (err) => reject(new Error((err && err.errMsg) || "识别失败")),
    });
  });
}

/* ============ 定位与天气 ============ */
function locationByIP() {
  return request({ path: "/api/location/ip", timeout: 12000 });
}

function weather(params) {
  return request({ path: "/api/weather", data: params, timeout: 20000 });
}

/* ============ 流式聊天（主聊天与通话共用核心，对齐 Web 版 streamChat） ============ */
/* hooks: onText(full), onSentence(list), onDone(tail, full)
   返回 { promise: Promise<{text, canceled, err}>, abort() } */
function chatStream(payload, hooks = {}) {
  let task = null;
  let aborted = false;
  const promise = new Promise((resolve) => {
    const decoder = new Utf8StreamDecoder();
    let acc = "";
    let pending = "";

    const ingest = (full) => {
      if (!full || full.length <= acc.length) return;
      pending += full.slice(acc.length);
      acc = full;
      if (hooks.onText) hooks.onText(full);
      if (hooks.onSentence) {
        const r = extractSentences(pending);
        pending = r.rest;
        if (r.out.length) hooks.onSentence(r.out);
      }
    };

    task = wx.request({
      url: app.globalData.baseUrl + "/api/chat",
      method: "POST",
      data: payload,
      header: { "Content-Type": "application/json" },
      enableChunked: true,
      timeout: 60000,
      success: (res) => {
        // wx.request 的 success 只代表网络层成功，必须自查 HTTP 状态码
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const d = res.data;
          const msg = (d && d.error) || `HTTP ${res.statusCode}`;
          resolve({
            text: acc,
            canceled: aborted,
            err: Object.assign(new Error(msg), { statusCode: res.statusCode }),
          });
          return;
        }
        // 兼容兜底：部分环境的 enableChunked 不触发 onChunkReceived，
        // 完整响应体只在 success 的 res.data 里（正常分片路径下 acc 已非空，这里不会重复）
        if (!acc && res.data) {
          ingest(typeof res.data === "string" ? res.data : JSON.stringify(res.data));
        }
        if (hooks.onDone) hooks.onDone(pending, acc);
        pending = "";
        resolve({ text: acc, canceled: aborted, err: null });
      },
      fail: (e) => {
        resolve({ text: acc, canceled: aborted, err: new Error((e && e.errMsg) || "网络错误") });
      },
    });

    task.onChunkReceived((res) => {
      try {
        ingest(decoder.decode(res.data));
      } catch (e) { /* 单块解码失败忽略 */ }
    });
  });
  return {
    promise,
    abort() {
      aborted = true;
      try { task.abort(); } catch (e) {}
    },
  };
}

module.exports = { request, checkAuth, login, fetchHealth, fetchVoices, tts, asr, locationByIP, weather, chatStream };
