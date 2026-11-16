# AI 女友 · 微信小程序版

与根目录的 Flask 后端（`app.py`）配套的小程序前端，全量移植了 Web 版功能：
流式聊天、性格/名字设定、访问密码、分句 TTS 朗读、语音输入、语音通话（VAD 自动断句）、定位与天气。

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss
├── pages/
│   ├── setup/          # 性格 + 名字设定
│   └── chat/           # 聊天主界面（含通话全屏浮层）
└── utils/
    ├── util.js         # UTF-8 流式解码 / 分句 / Markdown→rich-text / 存储
    ├── api.js          # 请求封装（chatStream 用 enableChunked 流式）
    ├── tts.js          # 分句朗读队列（预取下一句、可取消）
    └── asr.js          # PCM 录音 → WAV 上传（帧回调驱动 VAD）
```

## 使用步骤

1. 用微信开发者工具「导入项目」选择 `miniprogram/` 目录（AppID 可用测试号/游客模式）。
2. 先启动后端：项目根目录 `python app.py`（监听 127.0.0.1:5000）。
3. 开发者工具右上角「详情 → 本地设置」勾选 **不校验合法域名**（连本机 http 才可用）。
4. 编译运行。真机预览需手机与电脑同一局域网，并把 `app.js` 里 `baseUrl` 改成电脑的局域网 IP（如 `http://192.168.x.x:5000`）；Flask 需以 `host=0.0.0.0` 启动。

## 与 Web 版的实现差异

| 能力 | Web | 小程序 |
|---|---|---|
| 流式聊天 | axios onDownloadProgress | `wx.request` `enableChunked` + 自实现 UTF-8 增量解码 |
| 分句朗读播放 | Blob + Audio | ArrayBuffer → 写临时文件 → `innerAudioContext` |
| 语音输入 | MediaRecorder | `RecorderManager`（pcm 16k 单声道） |
| VAD 断句 | AnalyserNode 音量轮询 | `onFrameRecorded` PCM 帧 RMS |
| 浏览器语音兜底 | speechSynthesis | 无（TTS 失败时静默跳过该句） |
| Markdown 渲染 | 正则拼 HTML | `markdownToNodes` → `rich-text` 节点 |
| 定位 | 浏览器 geolocation | `wx.getLocation`（需在 app.json 声明权限，已配置） |

## 正式上线需要

- HTTPS + 备案域名的后端（微信强制要求），替换 `app.js` 中的 `baseUrl`
- 小程序后台「开发管理 → 服务器域名」配置 request 合法域名
- 注册小程序 AppID 替换 `project.config.json` 里的 `touristappid`
