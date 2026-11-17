"""AI 女友聊天机器人后端

一个基于 Flask 的轻量后端：
- 提供 /api/chat 接口，把对话转发给大模型并流式返回
- 支持设定女友的「名字」和「性格」，后端据此动态构造人设 system prompt
- 同时托管前端静态页面（static/ 目录）

默认使用智谱 AI（GLM）的 Anthropic 兼容接口；API Key 从 .env 或环境变量 ANTHROPIC_API_KEY 读取。
"""

import os
import re
import json
import time
import base64
import hashlib
import ipaddress
import uuid
import threading
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import anthropic
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory

# override=True：让 .env 里的配置优先于系统里可能残留的旧环境变量（如 ANTHROPIC_BASE_URL）
load_dotenv(override=True)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

MAX_TOKENS = int(os.environ.get("MAX_TOKENS", "8192"))
PORT = int(os.environ.get("PORT", "5000"))
DEBUG = os.environ.get("DEBUG", "0") == "1"
# 每次请求最多携带的历史消息条数（防止上下文无限膨胀、控制费用）
HISTORY_LIMIT = int(os.environ.get("HISTORY_LIMIT", "24"))

# 模型调用统一走 agent/router.py（多模型路由：DeepSeek 主力 + GLM 轻任务 + 故障回退）

WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]

# 火山引擎·豆包语音（TTS 语音合成 + ASR 语音识别）
VOLC_API_KEY = os.environ.get("VOLC_API_KEY", "")
VOLC_BASE = "https://openspeech.bytedance.com"
TTS_RESOURCE_ID = "seed-tts-2.0"
ASR_RESOURCE_ID = "volc.seedasr.auc"

# 音色：豆包大模型语音合成 2.0 的发音人 ID
TTS_VOICES = {
    "sweet":     {"label": "甜妹", "emoji": "🍬", "speaker": "zh_female_tianmeitaozi_uranus_bigtts"},
    "gentle":    {"label": "温柔", "emoji": "🌷", "speaker": "zh_female_wenroushunv_uranus_bigtts"},
    "sis":       {"label": "御姐", "emoji": "💄", "speaker": "zh_female_gaolengyujie_uranus_bigtts"},
    "loli":      {"label": "萝莉", "emoji": "🍭", "speaker": "zh_female_sajiaoxuemei_uranus_bigtts"},
    "energetic": {"label": "元气", "emoji": "⚡", "speaker": "zh_female_vv_uranus_bigtts"},
}
DEFAULT_TTS_VOICE = "sweet"
TTS_MAX_LEN = 500            # 单次朗读最大字符数
ASR_MAX_BYTES = 10 * 1024 * 1024  # ASR 单次音频上限 10MB
TTS_RETRIES = 2              # 豆包端点偶发失败时的重试次数

# 访问密码（部署公开访问时用；留空则无需密码，适合本地开发）
ACCESS_PASSWORD = os.environ.get("ACCESS_PASSWORD", "")
AUTH_COOKIE = "gf_auth"
_auth_token = ""
if ACCESS_PASSWORD:
    _auth_token = hashlib.sha256(("gf-chat:" + ACCESS_PASSWORD).encode("utf-8")).hexdigest()

# 通用线程安全 TTL 缓存：TTS 音频、地理编码、天气、IP 定位结果共用
_cache_lock = threading.Lock()
_cache = {}  # key -> (过期时间戳, value)
_CACHE_MAX = 256


def _cache_get(key):
    with _cache_lock:
        item = _cache.get(key)
        if not item:
            return None
        expires, value = item
        if time.time() >= expires:
            return None  # 过期（懒失效，等下次写入时清理）
        return value


def _cache_put(key, value, ttl, max_size=_CACHE_MAX):
    with _cache_lock:
        _cache[key] = (time.time() + ttl, value)
        if len(_cache) > max_size:  # 防止缓存无限膨胀
            now = time.time()
            for k in [k for k, (exp, _) in _cache.items() if exp < now]:
                _cache.pop(k, None)
            while len(_cache) > max_size:
                _cache.pop(next(iter(_cache)))


def _volc_tts_synthesize(text, speaker):
    """豆包语音合成：一次性输入文本，返回 MP3 字节。"""
    url = f"{VOLC_BASE}/api/v3/tts/unidirectional/sse"
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": VOLC_API_KEY,
        "X-Api-Resource-Id": TTS_RESOURCE_ID,
        "X-Api-Request-Id": str(uuid.uuid4()),
    }
    body = {
        "user": {"uid": "gf_chat"},
        "req_params": {
            "text": text,
            "speaker": speaker,
            "sample_rate": 24000,
            "audio_params": {
                "format": "mp3",
                "speech_rate": 0,
                "loudness_rate": 0,
                "bit_rate": 64000,
            },
            "additions": json.dumps(
                {
                    "post_process": {"pitch": 0},
                    "disable_markdown_filter": True,
                    "enable_latex_tn": False,
                }
            ),
        },
    }

    last_err = None
    for _ in range(TTS_RETRIES):
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8", errors="ignore")
        except urllib.error.HTTPError as e:
            last_err = RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', errors='ignore')[:200]}")
            continue
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue

        chunks = []
        for line in raw.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            try:
                d = json.loads(line[5:].strip())
            except Exception:  # noqa: BLE001
                continue
            code = d.get("code", 0)
            if code not in (0, 20000000):
                last_err = RuntimeError(f"TTS code={code}: {d.get('message', '')}")
                chunks = []
                break
            if d.get("data"):
                chunks.append(base64.b64decode(d["data"]))
        if chunks:
            return b"".join(chunks)
        last_err = last_err or RuntimeError("TTS 返回空音频")
    raise last_err


def _volc_asr(audio_bytes, fmt="wav"):
    """豆包录音文件识别极速版：传入音频字节，返回识别文本。"""
    url = f"{VOLC_BASE}/api/v3/auc/bigmodel/recognize/flash"
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": VOLC_API_KEY,
        "X-Api-Resource-Id": ASR_RESOURCE_ID,
        "X-Api-Request-Id": str(uuid.uuid4()),
        "X-Api-Sequence": "-1",
    }
    body = {
        "user": {"uid": "gf_chat"},
        "audio": {"data": base64.b64encode(audio_bytes).decode("ascii"), "format": fmt},
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
            "show_utterances": True,
        },
    }
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            status = resp.headers.get("X-Api-Status-Code", "")
            raw = resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        status = e.headers.get("X-Api-Status-Code", "")
        raw = e.read().decode("utf-8", errors="ignore")

    if status == "20000003":
        return ""  # 静音 / 无有效语音
    if status != "20000000":
        raise RuntimeError(f"ASR status={status}: {raw[:200]}")

    data = json.loads(raw)
    result = data.get("result", {})
    text = (result.get("text") or "").strip()
    if not text:
        for u in result.get("utterances", []):
            text += (u.get("text") or "").strip()
    return text.strip()


# ============ 定位与天气 ============
# 让 AI 女友知道用户所在的城市和实时天气，从而更贴近生活地关心对方。
# 天气/地理编码来自 Open-Meteo（免费、无需 Key）；
# IP 粗定位来自 ip-api.com（免费、无需 Key）；
# 坐标反查城市优先用 BigDataCloud，失败时回退 Nominatim。
WEATHER_TTL = 10 * 60        # 天气缓存时长（秒）
GEOCODE_TTL = 24 * 60 * 60   # 「城市名 → 坐标」缓存时长
IPLOC_TTL = 60 * 60          # 「IP → 城市」缓存时长
GEO_TIMEOUT = 8              # 外部定位/天气接口超时（秒）

# 坐标反查城市与取天气并行用（/api/weather 的 lat/lon 路径）
_GEO_POOL = ThreadPoolExecutor(max_workers=2)


def _http_get_json(url, timeout=GEO_TIMEOUT, retries=3):
    """GET JSON，带瞬时错误重试（境外 API 网络抖动时 SSL 握手可能超时）。"""
    delays = (0.0, 0.4, 1.0)  # 各次尝试前的等待
    last_exc = None
    for i in range(retries):
        if delays[i]:
            time.sleep(delays[i])
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "gf-chat/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.HTTPError, LookupError, ValueError):
            raise  # 业务错误（4xx/5xx）或 JSON 解析失败，重试无意义
        except Exception as e:  # noqa: BLE001 - URLError/SSL/超时等瞬时网络错误
            last_exc = e
    raise last_exc


# WMO 天气现象代码 → 中文描述
WMO_WEATHER = {
    0: "晴", 1: "基本晴", 2: "多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨",
    56: "冻毛毛雨", 57: "强冻毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
    80: "小阵雨", 81: "阵雨", 82: "强阵雨",
    85: "小阵雪", 86: "大阵雪",
    95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷阵雨伴冰雹",
}


def _wmo_text(code):
    return WMO_WEATHER.get(int(code), "天气未知")


def _wind_dir_text(deg):
    dirs = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]
    return dirs[int(((deg if deg is not None else 0) + 22.5) // 45) % 8] + "风"


def _geocode_city(city):
    """城市名 → (标准名, lat, lon)。使用 Open-Meteo Geocoding，支持中文。"""
    key = "geo:" + city
    hit = _cache_get(key)
    if hit is not None:
        return hit
    url = (
        "https://geocoding-api.open-meteo.com/v1/search?name="
        + urllib.parse.quote(city)
        + "&count=1&language=zh&format=json"
    )
    data = _http_get_json(url)
    results = data.get("results") or []
    if not results:
        raise LookupError("找不到该城市")
    r = results[0]
    value = (r.get("name") or city, float(r["latitude"]), float(r["longitude"]))
    _cache_put(key, value, GEOCODE_TTL)
    return value


def _reverse_geocode(lat, lon):
    """坐标 → 城市名。成功结果缓存 24h；失败时返回空串（天气仍可用，只是少显示城市）。"""
    key = f"rg:{lat:.3f},{lon:.3f}"
    hit = _cache_get(key)
    if hit is not None:
        return hit
    try:
        d = _http_get_json(
            "https://api.bigdatacloud.net/data/reverse-geocode-client"
            f"?latitude={lat}&longitude={lon}&localityLanguage=zh"
        )
        name = (d.get("city") or d.get("locality") or d.get("principalSubdivision") or "").strip()
        if name:
            _cache_put(key, name, GEOCODE_TTL)
            return name
    except Exception:  # noqa: BLE001
        pass
    try:
        d = _http_get_json(
            f"https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}"
            "&zoom=10&accept-language=zh&format=json"
        )
        addr = d.get("address") or {}
        name = (addr.get("city") or addr.get("town") or addr.get("county") or addr.get("state") or "").strip()
        if name:
            _cache_put(key, name, GEOCODE_TTL)
        return name
    except Exception:  # noqa: BLE001
        return ""


def _fetch_weather(lat, lon):
    """坐标 → 实时天气描述（含当天温度范围），带缓存。"""
    key = f"wx:{lat:.2f},{lon:.2f}"
    hit = _cache_get(key)
    if hit is not None:
        return hit
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,"
        "weather_code,wind_speed_10m,wind_direction_10m"
        "&daily=weather_code,temperature_2m_max,temperature_2m_min"
        "&forecast_days=1&timezone=auto"
    )
    data = _http_get_json(url)
    cur = data.get("current") or {}
    if not cur:
        raise RuntimeError("天气数据为空")
    day = data.get("daily") or {}

    desc = _wmo_text(cur.get("weather_code", -1))
    temp = round(float(cur.get("temperature_2m") or 0))
    feels = round(float(cur.get("apparent_temperature") or temp))
    humid = int(cur.get("relative_humidity_2m") or 0)
    wind_speed = round(float(cur.get("wind_speed_10m") or 0))
    wind_dir = _wind_dir_text(cur.get("wind_direction_10m"))
    short = f"{desc} {temp}°C"

    text = f"{desc}，气温 {temp}°C（体感 {feels}°C），湿度 {humid}%，{wind_dir} {wind_speed} 公里/小时"
    if day.get("temperature_2m_max") and day.get("temperature_2m_min"):
        t_max = round(float(day["temperature_2m_max"][0]))
        t_min = round(float(day["temperature_2m_min"][0]))
        text += f"；今天 {t_min}°C~{t_max}°C"
        day_desc = _wmo_text(day.get("weather_code", [0])[0])
        if day_desc and day_desc != desc:
            text += f"，{day_desc}"

    value = {"short": short, "text": text}
    _cache_put(key, value, WEATHER_TTL)
    return value


def _client_ip():
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr or ""


# 服务器可能跑在 UTC 时区的容器里（如 Sealos），时间统一按北京时间取
try:
    CN_TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # noqa: BLE001  tzdata 缺失时退回固定 +8（中国无夏令时）
    CN_TZ = timezone(timedelta(hours=8))


def now_text():
    now = datetime.now(CN_TZ)
    return f"{now.year}年{now.month}月{now.day}日 {WEEKDAYS[now.weekday()]} {now.strftime('%H:%M')}"

# 性格/角色卡已迁移至 agent/persona.py（预设 + 自定义角色卡）
# 长期记忆：agent/memory.py；轻量 RAG：agent/rag.py；多模型路由：agent/router.py
from agent import diary as agent_diary
from agent import intimacy as agent_intimacy
from agent import memory as agent_memory
from agent import persona as agent_persona
from agent import photo as agent_photo
from agent import proactive as agent_proactive
from agent import rag as agent_rag
from agent import router as agent_router


def _sanitize_prompt_text(value, limit):
    """清洗注入 prompt 的文本：去掉控制字符、压平空白、限制长度。"""
    value = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    return value[:limit]


def sanitize_name(name):
    """清洗名字：去掉控制字符、限制长度，避免破坏 prompt。"""
    return _sanitize_prompt_text(name, 20)


def _parse_location(data):
    """聊天与主动消息共用的位置字段清洗（前端定位/手动设置后随请求携带）。"""
    loc = data.get("location")
    if not isinstance(loc, dict):
        return None
    location = {
        "city": _sanitize_prompt_text(loc.get("city"), 30),
        "weather_text": _sanitize_prompt_text(loc.get("weather_text"), 200),
    }
    if not (location["city"] or location["weather_text"]):
        return None
    return location


app = Flask(__name__, static_folder="static", static_url_path="/static")


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/health")
def health():
    """健康检查，暴露主力对话模型名与照片功能可用性给前端展示。"""
    try:
        primary = agent_router._PROVIDERS.get(agent_router.CHAT_CHAIN[0])
        model = primary["model"] if primary else "未配置"
    except Exception:  # noqa: BLE001
        model = "未配置"
    return jsonify({"status": "ok", "model": model, "photo": agent_photo.available()})


@app.route("/api/auth")
def auth_status():
    """前端据此判断是否需要弹登录框。"""
    authed = (not ACCESS_PASSWORD) or (request.cookies.get(AUTH_COOKIE) == _auth_token)
    return jsonify({"authed": authed})


@app.route("/api/login", methods=["POST", "OPTIONS"])
def login():
    if request.method == "OPTIONS":
        return ("", 204)
    if not ACCESS_PASSWORD:
        return jsonify({"ok": True})
    data = request.get_json(silent=True) or {}
    if str(data.get("password") or "") == ACCESS_PASSWORD:
        resp = jsonify({"ok": True})
        resp.set_cookie(
            AUTH_COOKIE, _auth_token,
            max_age=60 * 60 * 24 * 30, httponly=True, samesite="Lax",
        )
        return resp
    return jsonify({"error": "密码错误"}), 401


@app.before_request
def _require_auth():
    """公开部署时保护 /api 接口（静态页面与登录/健康检查除外）。"""
    if not ACCESS_PASSWORD:
        return None
    if not request.path.startswith("/api/"):
        return None
    if request.path in ("/api/login", "/api/auth", "/api/health"):
        return None
    if request.method == "OPTIONS":
        return None
    if request.cookies.get(AUTH_COOKIE) == _auth_token:
        return None
    return jsonify({"error": "未授权"}), 401


@app.route("/api/tts/voices")
def tts_voices():
    """把可选音色列表暴露给前端。"""
    return jsonify(
        [
            {"key": k, "label": v["label"], "emoji": v["emoji"]}
            for k, v in TTS_VOICES.items()
        ]
    )


@app.route("/api/tts", methods=["POST", "OPTIONS"])
def tts():
    """文本转语音：返回 MP3 音频流。请求体 { text, voice }。"""
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or {}
    text = re.sub(r"\s+", " ", str(data.get("text") or "")).strip()
    voice_key = data.get("voice") or DEFAULT_TTS_VOICE
    v = TTS_VOICES.get(voice_key, TTS_VOICES[DEFAULT_TTS_VOICE])

    if not text:
        return jsonify({"error": "text 不能为空"}), 400
    text = text[:TTS_MAX_LEN]

    cache_key = (voice_key, text)
    cached = _cache_get(cache_key)
    if cached is not None:
        return Response(cached, mimetype="audio/mpeg")

    try:
        audio = _volc_tts_synthesize(text, v["speaker"])
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"语音合成失败：{e}"}), 502

    _cache_put(cache_key, audio, 24 * 60 * 60, max_size=64)
    return Response(audio, mimetype="audio/mpeg")


@app.route("/api/asr", methods=["POST", "OPTIONS"])
def asr():
    """语音识别：接收音频（二进制或 JSON base64），返回识别文本。"""
    if request.method == "OPTIONS":
        return ("", 204)

    fmt = request.args.get("format", "wav")
    content_type = (request.content_type or "").lower()

    if "application/json" in content_type:
        data = request.get_json(silent=True) or {}
        fmt = data.get("format", fmt)
        b64 = data.get("audio") or data.get("data") or ""
        try:
            audio = base64.b64decode(b64)
        except Exception:  # noqa: BLE001
            return jsonify({"error": "audio base64 格式不正确"}), 400
    else:
        audio = request.get_data()

    if not audio:
        return jsonify({"error": "audio 不能为空"}), 400
    if len(audio) > ASR_MAX_BYTES:
        return jsonify({"error": "audio 太大"}), 400

    try:
        text = _volc_asr(audio, fmt)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"语音识别失败：{e}"}), 502

    return jsonify({"text": text})


@app.route("/api/location/ip")
def location_by_ip():
    """根据客户端 IP 粗定位城市（部署在公网时可用；本机访问返回空）。"""
    ip = _client_ip()
    key = "ip:" + ip
    hit = _cache_get(key)
    if hit is not None:
        return jsonify(hit)

    try:
        addr = ipaddress.ip_address(ip)
        if addr.is_private or addr.is_loopback or addr.is_reserved or addr.is_link_local:
            return jsonify({"city": None})  # 内网/回环地址无法定位
    except ValueError:
        return jsonify({"city": None})

    try:
        d = _http_get_json(
            f"http://ip-api.com/json/{ip}?lang=zh-CN&fields=status,message,city,lat,lon"
        )
        if d.get("status") != "success" or not d.get("city"):
            raise RuntimeError(d.get("message") or "定位失败")
    except Exception:  # noqa: BLE001
        return jsonify({"city": None})

    value = {"city": d["city"], "lat": d["lat"], "lon": d["lon"]}
    _cache_put(key, value, IPLOC_TTL)
    return jsonify(value)


@app.route("/api/weather")
def weather():
    """查询天气：?city=城市名，或 ?lat=&lon=（可带 &name=城市名 免反查）。"""
    lat = request.args.get("lat", type=float)
    lon = request.args.get("lon", type=float)
    name = request.args.get("name", "").strip()
    city_param = request.args.get("city", "").strip()

    try:
        if city_param:
            city, g_lat, g_lon = _geocode_city(city_param)
            wx = _fetch_weather(g_lat, g_lon)
        elif lat is not None and lon is not None:
            g_lat, g_lon = lat, lon
            if name:
                wx = _fetch_weather(g_lat, g_lon)
                city = name
            else:
                # 反查城市与取天气互不依赖，并行执行
                rg = _GEO_POOL.submit(_reverse_geocode, g_lat, g_lon)
                wx = _fetch_weather(g_lat, g_lon)
                city = rg.result()
        else:
            return jsonify({"error": "缺少 city 或 lat/lon 参数"}), 400
    except LookupError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"天气查询失败：{e}"}), 502

    return jsonify({
        "city": city,
        "lat": g_lat,
        "lon": g_lon,
        "weather_text": wx["text"],
        "short": wx["short"],
        "refresh_after": WEATHER_TTL,
    })


def _valid_messages(messages):
    if not isinstance(messages, list):
        return False
    for m in messages:
        if not isinstance(m, dict):
            return False
        if m.get("role") not in ("user", "assistant"):
            return False
        if not isinstance(m.get("content"), str):
            return False
    return True


LESSONS_PATH = os.path.join(BASE_DIR, "evals", "reviews", "lessons.jsonl")
_lessons_cache = None  # (mtime, formatted_block)
_lessons_lock = threading.Lock()


def _load_lessons(limit=8):
    """失败复盘教训（eval runner 失败时写入 lessons.jsonl），注入 prompt 避免重蹈覆辙。
    mtime 缓存：文件没变就不重读。"""
    global _lessons_cache
    try:
        mtime = os.path.getmtime(LESSONS_PATH)
    except OSError:
        return ""
    with _lessons_lock:
        if _lessons_cache is not None and _lessons_cache[0] == mtime:
            return _lessons_cache[1]
        try:
            with open(LESSONS_PATH, encoding="utf-8") as f:
                lines = [ln.strip() for ln in f if ln.strip()]
        except OSError:
            return ""
        out = []
        for ln in lines[-limit:]:
            try:
                item = json.loads(ln)
                text = str(item.get("lesson") or "").strip()
                if text:
                    out.append(f"- {text[:150]}")
            except ValueError:
                continue
        block = "\n".join(out)
        _lessons_cache = (mtime, block)
        return block


# 错误哨兵：generate() 的所有错误 yield 都以这些前缀开头，
# 记忆抽取据此跳过错误文本（防止单一前缀漂移导致错误内容污染长期记忆）
ERROR_PREFIXES = ("[错误]", "[请求失败]")


def _looks_like_error(text):
    t = str(text or "").lstrip()
    return any(t.startswith(p) for p in ERROR_PREFIXES)


def _extraction_worker(space, user_text, assistant_text, history_tail):
    """后台记忆抽取：失败只记日志，绝不影响主对话。"""
    try:
        store = agent_memory.get_store(space)
        ids = agent_memory.extract_and_store(store, user_text, assistant_text, history_tail)
        if ids:
            # 被记住本身就是亲近的信号：新记忆加好感（纠正类更重要，单轮最多 +3）
            new_ids = set(ids)
            points = sum(
                3 if m.get("type") == "correction" else 1
                for m in store.items if m.get("id") in new_ids
            )
            agent_intimacy.add(space, min(3, points), "memory", cap_daily=False)
            print(f"[memory] +{len(ids)} 条 ({store.space})", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[memory] 抽取线程异常: {e}", flush=True)


@app.route("/api/chat", methods=["POST", "OPTIONS"])
def chat():
    if request.method == "OPTIONS":
        return ("", 204)

    data = request.get_json(silent=True) or {}
    messages = data.get("messages")
    name = sanitize_name(data.get("name"))
    personality = data.get("personality") or "gentle"
    greeting = bool(data.get("greeting"))
    call_mode = bool(data.get("call"))
    greeting_text = _sanitize_prompt_text(data.get("greeting_text"), 200)

    # 位置信息（前端定位/手动设置后随请求携带）：注入 system prompt
    location = _parse_location(data)

    if not _valid_messages(messages):
        return jsonify({"error": "messages 格式不正确"}), 400

    if not messages and not greeting:
        return jsonify({"error": "messages 不能为空"}), 400

    # ===== Agent 组装：角色卡 + 长期记忆 + RAG 检索 + 复盘教训 =====
    card = agent_persona.get_card(personality)
    if name:
        card = {**card, "name": name}  # 用户给角色起的名字优先于预设名

    space = card["key"]
    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")

    mem_store = agent_memory.get_store(space)
    memories_block = mem_store.to_prompt(mem_store.search(last_user or "打招呼 问候", k=6))

    rag_store = agent_rag.get_rag_store(space)
    rag_hits = rag_store.search(last_user, k=3) if last_user else []
    rag_block = rag_store.to_prompt(rag_hits)

    system_prompt = agent_persona.build_system_prompt(
        card, now_text(), location,
        memories_block=memories_block, rag_block=rag_block,
        lessons_block=_load_lessons(), call_mode=call_mode,
        greeting_text=greeting_text,
        intimacy_block=agent_intimacy.prompt_block(space),
        photo_hint=agent_photo.available() and not call_mode,
    )

    # 只携带最近 N 条历史，防止上下文无限膨胀
    model_messages = messages[-HISTORY_LIMIT:]
    # 开场白：无历史消息时，让模型主动说一句开场白
    if greeting and not messages:
        seed = (
            "（对话现在开始。请以角色身份主动向我发一条简短、自然的开场白，让我们认识一下。直接说话，不要任何解释。）"
        )
        model_messages = [{
            "role": "user",
            "content": seed,
        }]

    def generate():
        acc = []
        try:
            for text in agent_router.stream(
                model_messages, system_prompt,
                route="chat", max_tokens=MAX_TOKENS,
            ):
                acc.append(text)
                yield text
        except anthropic.AuthenticationError:
            yield "\n\n[错误] API Key 无效，请检查 .env 配置。"
        except anthropic.RateLimitError:
            yield "\n\n[错误] 请求过于频繁或额度不足（所有模型均如此），请稍后再试。"
        except anthropic.APIConnectionError:
            yield "\n\n[错误] 无法连接到 API，请检查网络。"
        except anthropic.APIStatusError as exc:
            yield f"\n\n[错误] API 返回 {exc.status_code}：{exc.message}"
        except Exception as exc:  # noqa: BLE001
            print(f"[chat] 全部模型失败: {exc}", flush=True)
            yield "\n\n[错误] 所有模型均不可用，请检查网络或 API Key。"
        finally:
            # 非开场白的完整一轮：加好感并后台抽取长期记忆（不阻塞响应）
            full_text = "".join(acc)
            if not greeting and full_text and not _looks_like_error(full_text):
                agent_intimacy.add_turn(space)
                threading.Thread(
                    target=_extraction_worker,
                    args=(space, last_user, full_text, messages[-6:]),
                    daemon=True,
                ).start()

    return Response(
        generate(),
        mimetype="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ============ Agent 管理接口：角色卡 / 长期记忆 / RAG 文档 ============

@app.route("/api/personas", methods=["GET"])
def personas_list():
    """全部角色卡（预设 + 自定义）。"""
    return jsonify(agent_persona.list_cards())


@app.route("/api/personas", methods=["POST"])
def personas_save():
    data = request.get_json(silent=True) or {}
    try:
        card = agent_persona.save_custom_card(
            data.get("key") or data.get("name"),
            data.get("name"),
            data.get("persona"),
            data.get("boundaries"),
            _sanitize_prompt_text(data.get("emoji") or "🎭", 8),
        )
        return jsonify({"ok": True, "card": card})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/personas/<key>", methods=["DELETE"])
def personas_delete(key):
    ok = agent_persona.delete_custom_card(key)
    return (jsonify({"ok": True}) if ok else (jsonify({"error": "角色不存在"}), 404))


def _resolve_space(space_param):
    """面板/端点的 space 与聊天写入侧走同一套角色解析（未知 key 落到 gentle）。"""
    return agent_persona.get_card(space_param or "default")["key"]


@app.route("/api/memories")
def memories_list():
    store = agent_memory.get_store(_resolve_space(request.args.get("space", "default")))
    items = sorted(store.items, key=lambda m: -m["ts"])
    return jsonify([
        {"id": m["id"], "type": m["type"], "content": m["content"], "ts": m["ts"]}
        for m in items[:100]
    ])


@app.route("/api/memories/<mid>", methods=["DELETE"])
def memories_delete(mid):
    store = agent_memory.get_store(_resolve_space(request.args.get("space", "default")))
    ok = store.delete(mid)
    return (jsonify({"ok": True}) if ok else (jsonify({"error": "记忆不存在"}), 404))


@app.route("/api/docs")
def docs_list():
    return jsonify(agent_rag.get_rag_store(_resolve_space(request.args.get("space", "default"))).list_docs())


@app.route("/api/docs", methods=["POST"])
def docs_upload():
    """上传资料文本（日记/聊天记录等）：{ name, text }。"""
    data = request.get_json(silent=True) or {}
    name = _sanitize_prompt_text(data.get("name"), 100)
    text = str(data.get("text") or "")
    if len(text) > 200_000:
        return jsonify({"error": "文档过长（上限 20 万字）"}), 400
    if not name:
        return jsonify({"error": "缺少 name"}), 400
    store = agent_rag.get_rag_store(_resolve_space(request.args.get("space", "default")))
    try:
        info = store.add_doc(name, text)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, **info})


@app.route("/api/docs/<doc_id>", methods=["DELETE"])
def docs_delete(doc_id):
    store = agent_rag.get_rag_store(_resolve_space(request.args.get("space", "default")))
    ok = store.delete_doc(doc_id)
    return (jsonify({"ok": True}) if ok else (jsonify({"error": "文档不存在"}), 404))


# ============ 亲密度 / 照片 / 日记 / 时间线 / 主动消息 ============

@app.route("/api/intimacy")
def intimacy_info():
    """关系进度：分数、等级、距下一级还差多少。"""
    space = _resolve_space(request.args.get("space", "default"))
    return jsonify(agent_intimacy.info(space))


@app.route("/api/photo", methods=["POST", "OPTIONS"])
def photo_generate():
    """生成一张她的照片：{ scene, force }，返回本地图片 URL。"""
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(silent=True) or {}
    scene = _sanitize_prompt_text(data.get("scene") or data.get("prompt"), 200)
    if not scene:
        return jsonify({"error": "缺少画面描述"}), 400
    if not agent_photo.available():
        return jsonify({"error": "dreamina-canvas CLI 未安装或未登录"}), 503
    try:
        info = agent_photo.generate(scene, force=bool(data.get("force")))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"照片生成失败：{e}"}), 502
    return jsonify(info)


@app.route("/api/diary")
def diary_list():
    space = _resolve_space(request.args.get("space", "default"))
    return jsonify(agent_diary.list_entries(space))


@app.route("/api/diary/generate", methods=["POST", "OPTIONS"])
def diary_generate():
    """写某天的日记：{ messages, personality, name, date, force }。"""
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(silent=True) or {}
    messages = data.get("messages")
    if not isinstance(messages, list):
        return jsonify({"error": "messages 格式不正确"}), 400
    card = agent_persona.get_card(data.get("personality") or "gentle")
    name = sanitize_name(data.get("name"))
    if name:
        card = {**card, "name": name}
    try:
        entry = agent_diary.generate(
            card["key"], card, messages,
            date_str=_sanitize_prompt_text(data.get("date"), 10) or None,
            force=bool(data.get("force")),
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(entry)


@app.route("/api/profile")
def profile_card():
    """「她眼中的你」：从长期记忆生成，记忆不变则复用缓存。"""
    space = _resolve_space(request.args.get("space", "default"))
    card = agent_persona.get_card(space)
    store = agent_memory.get_store(space)
    items = [m["content"] for m in sorted(store.items, key=lambda m: -m["ts"])[:40]]
    try:
        return jsonify(agent_diary.profile(
            space, card, items, force=request.args.get("force") == "1"
        ))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"生成失败：{e}"}), 502


@app.route("/api/timeline")
def timeline():
    """关系时间线：初次相遇 + 等级里程碑 + 重要事件 + 日记。"""
    space = _resolve_space(request.args.get("space", "default"))
    st = agent_intimacy.info(space)
    items = []
    if st.get("created"):
        items.append({
            "ts": st["created"], "type": "start",
            "title": "初次相遇", "desc": "你们的故事从这里开始",
        })
    for ms in st.get("milestones") or []:
        items.append({
            "ts": ms.get("ts") or 0, "type": "level",
            "title": f"关系升级为「{ms.get('name', '')}」",
            "desc": f"Lv.{ms.get('level', '')}",
        })
    for m in agent_memory.get_store(space).items:
        if m.get("type") == "event":
            items.append({
                "ts": m.get("ts") or 0, "type": "event",
                "title": "重要的事", "desc": m.get("content", ""),
            })
    for e in agent_diary.list_entries(space):
        items.append({
            "ts": e.get("ts") or 0, "type": "diary",
            "title": f"{e.get('date', '')} 的日记",
            "desc": (e.get("text") or "")[:80],
        })
    items.sort(key=lambda x: -float(x.get("ts") or 0))
    return jsonify(items[:80])


@app.route("/api/proactive", methods=["POST", "OPTIONS"])
def proactive_message():
    """她主动发一条消息：{ messages, personality, name, location }。"""
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(silent=True) or {}
    messages = data.get("messages")
    if not isinstance(messages, list):
        messages = []
    if not any(isinstance(m, dict) and m.get("role") == "user" for m in messages):
        return jsonify({"message": None, "reason": "no-history"})

    card = agent_persona.get_card(data.get("personality") or "gentle")
    name = sanitize_name(data.get("name"))
    if name:
        card = {**card, "name": name}

    space = card["key"]
    last_user = next(
        (m["content"] for m in reversed(messages)
         if isinstance(m, dict) and m.get("role") == "user"), ""
    )
    store = agent_memory.get_store(space)
    memories_block = store.to_prompt(store.search(last_user, k=4))
    return jsonify(agent_proactive.maybe(
        space, card, messages, memories_block, _parse_location(data)
    ))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, debug=DEBUG, threaded=True)
