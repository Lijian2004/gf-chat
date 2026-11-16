/* 分句朗读播放队列（移植 Web 版 createSpeechQueue，播放改为 innerAudioContext + 临时文件）
   opts:
     canSpeak()  —— 是否继续播放（关语音 / 通话挂断时返回 false）
     onSpeak()   —— 每句开始播放前回调（通话模式切换「正在说话」状态）
     onDrained() —— 队列排空时回调（通话模式播完自动回到聆听） */
const api = require("./api");
const { textForSpeech } = require("./util");

const fs = wx.getFileSystemManager();
let fileSeq = 0;

function blobToTempFile(buffer) {
  const path = `${wx.env.USER_DATA_PATH}/tts_${Date.now()}_${fileSeq++}.mp3`;
  fs.writeFileSync(path, buffer, "binary");
  return path;
}

function removeTempFile(path) {
  try { fs.unlinkSync(path); } catch (e) { /* 忽略 */ }
}

/* 播放一段 MP3 ArrayBuffer；返回 { promise, stop() } */
function playBuffer(buffer) {
  const ctx = wx.createInnerAudioContext();
  ctx.src = blobToTempFile(buffer);
  let done = false;
  let timer = null;
  let resolveFn = null;
  const finish = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    removeTempFile(ctx.src);
    try { ctx.destroy(); } catch (e) {}
    if (resolveFn) resolveFn();
  };
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
    ctx.onEnded(finish);
    ctx.onError(finish);
    timer = setTimeout(finish, 120000); // 绝对兜底
    ctx.play();
  });
  return { promise, stop: finish };
}

function createSpeechQueue(opts = {}) {
  const canSpeak = opts.canSpeak || (() => true);
  const onSpeak = opts.onSpeak || (() => {});
  const onDrained = opts.onDrained || (() => {});
  let queue = [];
  let busy = false;
  let prefetch = null; // { text, promise, abort }
  let gen = 0;
  let current = null; // { promise, stop }

  function abortPrefetch() {
    if (prefetch && prefetch.abort) { try { prefetch.abort(); } catch (e) {} }
    prefetch = null;
  }

  function stopCurrent() {
    if (current) current.stop();
    current = null;
  }

  /* 打断：清空未播放的句子并取消在途预取 */
  function cancelPending() {
    gen++;
    queue = [];
    abortPrefetch();
  }

  /* 彻底重置：打断 + 停止当前播放 */
  function reset() {
    cancelPending();
    stopCurrent();
  }

  function enqueue(list) {
    if (!list || !list.length || !canSpeak()) return;
    queue.push(...list);
    pump();
  }

  async function pump() {
    if (busy || !canSpeak()) return;
    const sentence = queue.shift();
    if (sentence == null) {
      onDrained();
      return;
    }
    const g = gen;
    busy = true;
    let clean = "";
    try {
      onSpeak();
      clean = textForSpeech(sentence);
      if (clean) {
        let blobPromise;
        if (prefetch && prefetch.text === clean) {
          blobPromise = prefetch.promise; // 命中预取，直接播放
          prefetch = null;
        } else {
          blobPromise = api.tts(clean, opts.voice ? opts.voice() : "gentle");
        }
        // 当前句播放期间预取下一句，消除句间停顿；打断时取消预取请求
        const nextClean = textForSpeech(queue[0] || "");
        if (nextClean) {
          const p = api.tts(nextClean, opts.voice ? opts.voice() : "gentle");
          const wrapped = p.catch(() => null);
          prefetch = { text: nextClean, promise: wrapped, abort: () => p.abort() };
        } else {
          prefetch = null;
        }
        const buffer = await blobPromise;
        if (g !== gen || !canSpeak()) return; // 已被打断
        if (!buffer || !buffer.byteLength) throw new Error("empty audio");
        current = playBuffer(buffer);
        await current.promise;
        current = null;
      }
    } catch (e) {
      abortPrefetch();
      current = null;
      if (g === gen && canSpeak() && clean) {
        // 小程序无浏览器语音兜底；短暂等待后继续下一句，避免卡死
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      busy = false;
    }
    if (g === gen && canSpeak()) pump();
  }

  return {
    enqueue,
    pump,
    cancelPending,
    reset,
    stopCurrent,
    isBusy: () => busy,
    isPlaying: () => !!current,
  };
}

module.exports = { createSpeechQueue };
