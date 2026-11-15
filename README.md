# AI 女友聊天机器人

一个前后端分离的「AI 女友」聊天机器人：

- **前端**：HTML + CSS + JavaScript + [Axios](https://axios-http.com/) —— 启动时选择性格、起名字，进入聊天后流式渲染，带打字动画、Markdown / 代码高亮
- **后端**：Python + Flask + Anthropic SDK，默认调用 **智谱 AI（GLM-5.3-Flash，走 Anthropic 兼容接口）**，根据名字和性格动态构造人设并流式返回

## 目录结构

```
chat/
├── app.py            # Flask 后端（同时托管前端静态页面）
├── requirements.txt  # Python 依赖
├── .env              # API Key 与模型配置（已加入 .gitignore，勿提交）
├── static/
│   ├── index.html    # 页面结构（含性格/名字设定界面）
│   ├── style.css     # 样式
│   └── script.js     # 交互逻辑（设定流程 + axios 流式渲染）
└── README.md
```

## 快速开始

### 1. 准备环境

需要 Python 3.9+。

### 2. 安装依赖

```bash
pip install -r requirements.txt
```

### 3. 配置 API Key

编辑项目根目录下的 `.env` 文件：

```ini
ANTHROPIC_API_KEY=你的密钥
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
MODEL=GLM-5.3-Flash
MAX_TOKENS=8192
```

> 也可以不建 `.env`，直接在命令行设置环境变量。注意：`.env` 的优先级高于系统环境变量（见下文）。

### 4. 启动服务

```bash
python app.py
```

### 5. 打开页面

浏览器访问 <http://localhost:5000>。

## 配置说明（.env / 环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | 无 | API 密钥（智谱 BigModel） |
| `ANTHROPIC_BASE_URL` | `https://open.bigmodel.cn/api/anthropic` | API 地址（Anthropic 兼容端点） |
| `MODEL` | `GLM-5.3-Flash` | 使用的模型（也可换成 `GLM-5.3-FlashX`） |
| `MAX_TOKENS` | `8192` | 单次回复的最大输出 token |
| `TEMPERATURE` | `0.85` | 回复随机性，越高越活泼 |
| `HISTORY_LIMIT` | `24` | 每次请求最多携带的历史消息条数 |
| `REQUEST_TIMEOUT` | `60` | 调用上游 API 的超时时间（秒） |
| `PORT` | `5000` | 服务端口 |
| `DEBUG` | `0` | 设为 `1` 开启 Flask 调试模式（生产环境勿开） |

> **换更强的模型**：把 `MODEL` 改成 `GLM-5.3-FlashX` 即可。
> **想换回 Claude / DeepSeek**：改 `.env` 里的 `ANTHROPIC_BASE_URL`、`MODEL`、`ANTHROPIC_API_KEY` 即可（SDK 用 `ANTHROPIC_API_KEY` 认证，`base_url` 决定发往哪个服务商）。

## 性格设定

前端提供 6 种性格，对应后端的 `personality` 参数：

| key | 性格 | 说明 |
| --- | --- | --- |
| `gentle` | 温柔 🌷 | 轻声细语，治愈你的每一天 |
| `tsundere` | 傲娇 😤 | 口是心非，藏不住对你的喜欢 |
| `aloof` | 高冷 ❄️ | 话少可靠，偶尔流露温柔 |
| `sharp` | 犀利 ⚡ | 一针见血，聪明爱吐槽 |
| `grumpy` | 暴躁 🔥 | 脾气来得快去得快，其实很在意你 |
| `shy` | 害羞 🌸 | 容易脸红，需要你主动一点 |

## 接口说明

`POST /api/chat`

请求体：

```json
{
  "name": "小晴",
  "personality": "tsundere",
  "greeting": false,
  "messages": [
    { "role": "user", "content": "今天过得好吗？" }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 女友名字 |
| `personality` | string | 性格 key（见上表） |
| `greeting` | bool | 为 `true` 时生成开场白（此时 `messages` 可为空） |
| `messages` | array | 对话历史，`[{ role, content }]` |

响应：`text/plain` 流式返回女友的回复正文。

可选字段 `greeting_text`：前端把之前生成的开场白带回给后端，注入 system prompt 作为上下文，让模型自然衔接而不重复开场白。

其他接口：

- `GET /api/health`：健康检查，返回 `{ status, model }`（前端用它动态显示模型名）。
- `GET /api/location/ip`：按客户端 IP 粗定位城市（部署公网时可用，本机访问返回空）。
- `GET /api/weather`：天气查询，`?city=城市名` 或 `?lat=&lon=`（可带 `&name=` 免反查），返回 `{ city, lat, lon, weather_text, short }`。

可选字段 `location`（`/api/chat` 请求体）：`{ "city": "杭州", "weather_text": "小毛毛雨，气温 16°C… }`，后端会把城市与实时天气注入 system prompt。

## 语音通话

聊天头部点击 📞 进入全屏通话界面（类似豆包的语音通话）：

- **自动断句**：浏览器端实时检测音量（自适应噪声底），说完停顿约 1.4 秒她自动接话，无需手动操作
- **实时字幕**：通话界面内显示双方对话内容，头像呼吸灯随「聆听 / 说话」状态变化
- **流式分句朗读**：她的回复边生成边按句合成播放，不用等全部内容生成完，响应更快
- **通话模式人设**：通话时回复自动变短、纯口语（无 Markdown / 表情），更像打电话
- **静音 / 挂断**：支持随时静音和挂断；TTS 失败自动回退浏览器语音
- **记忆同步**：通话内容实时写入主聊天记录，挂断后可在聊天界面回看，她也记得说过什么

## 定位与天气

让她知道你在哪个城市、天气如何，聊天时能自然地提醒「降温添衣」「下雨带伞」：

- **自动定位**：进入页面后优先 IP 定位（静默无感），失败时回退浏览器定位（需授权），还不行可手动输入城市名
- **实时天气**：来自 [Open-Meteo](https://open-meteo.com/)（免费无需 Key），含实时温度、体感、湿度、风向与当天温度范围，每 10 分钟自动刷新
- **侧边栏卡片**：「你在的城市」显示 `📍 城市 · 天气`，点击可修改城市或重新定位
- **缓存**：天气缓存 10 分钟、城市坐标缓存 24 小时，避免频繁请求外部接口

## 优化特性

- **对话持久化**：聊天记录、人设与开场白保存在浏览器 `localStorage`，刷新页面不丢，自动回到聊天界面
- **上下文控制**：后端只携带最近 `HISTORY_LIMIT` 条历史，防止上下文无限膨胀、控制 token 费用
- **开场白衔接**：开场白不写入消息列表，而是作为上下文注入 system prompt，避免消息角色顺序问题
- **时间感知**：system prompt 注入当前日期时间与星期，早晚问候更自然
- **城市与天气感知**：自动定位用户城市并注入实时天气，让她能结合天气关心你（见上节）
- **智能滚动**：流式输出时自动跟随，用户回看历史消息时不会被强制拉到底部
- **移动端适配**：侧边栏隐藏时，聊天头部提供「重新设定」入口
- **语音通话**：一键进入通话模式，VAD 自动断句 + 分句 TTS 流式播放（见上节）
- **错误提示**：请求失败时气泡红色高亮显示
