/* 录音 + PCM→WAV 封装（语音输入与通话共用）
   RecorderManager 录 pcm 格式，onFrameRecorded 提供 PCM 帧供 VAD 算音量；
   stop 时把收集的 PCM 帧加 44 字节 WAV 头上传 /api/asr。 */
const SAMPLE_RATE = 16000;
const FRAME_MS = 125; // frameSize: 4KB @16k16bit ≈ 125ms/帧

let rec = wx.getRecorderManager();
let frameHandler = null;
let stopResolver = null;

rec.onFrameRecorded((res) => {
  if (frameHandler && res.frameBuffer && res.frameBuffer.byteLength) {
    frameHandler(new Int16Array(res.frameBuffer));
  }
});

rec.onError(() => {
  const h = frameHandler;
  frameHandler = null;
  if (h) h(null); // null 表示出错，调用方据此复位
});

rec.onStop((res) => {
  const resolve = stopResolver;
  stopResolver = null;
  if (!resolve) return;
  // tempFilePath 是完整 pcm 文件，比逐帧累积更可靠
  if (res && res.tempFilePath) {
    wx.getFileSystemManager().readFile({
      filePath: res.tempFilePath,
      success: (r) => {
        const pcm = new Uint8Array(r.data);
        resolve(pcm.byteLength >= SAMPLE_RATE ? pcmToWav(pcm) : null); // <0.2s 视为无声
      },
      fail: () => resolve(null),
    });
  } else {
    resolve(null);
  }
});

/* 开始录音；onFrame(int16Array|null) 每 ~125ms 回调一帧（null=出错） */
function start(onFrame) {
  frameHandler = onFrame || null;
  rec.start({
    format: "pcm",
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    frameSize: 4, // KB
    duration: 60000,
  });
}

/* 停止录音，返回 WAV ArrayBuffer（无声/出错返回 null） */
function stop() {
  return new Promise((resolve) => {
    frameHandler = null;
    stopResolver = resolve;
    try {
      rec.stop();
    } catch (e) {
      stopResolver = null;
      resolve(null);
    }
    setTimeout(() => {
      if (stopResolver === resolve) {
        stopResolver = null;
        resolve(null);
      }
    }, 3000); // 兜底
  });
}

/* RMS 音量（0~1 量级），供 VAD 使用 */
function frameRms(int16) {
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / int16.length);
}

/* PCM(16k 单声道 16bit) → WAV（44 字节头） */
function pcmToWav(pcmBytes) {
  const header = new ArrayBuffer(44 + pcmBytes.length);
  const view = new DataView(header);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.length, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  str(36, "data");
  view.setUint32(40, pcmBytes.length, true);
  new Uint8Array(header, 44).set(pcmBytes);
  return header;
}

module.exports = { start, stop, frameRms, SAMPLE_RATE, FRAME_MS };
