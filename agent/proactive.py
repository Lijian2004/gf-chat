"""她主动找你：用户久未发消息时，主动生成一条像真人发的消息。

约束（避免打扰）：
- 只在 8:00-23:00（北京时间）
- 同一角色冷却 45 分钟
- 每天最多 4 条
存储：data/proactive/<space>.json
"""
import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    CN_TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # noqa: BLE001
    CN_TZ = timezone(timedelta(hours=8))

from agent import router
from agent.memory import normalize_space
from agent.textproc import atomic_write_json

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
PROACTIVE_DIR = os.path.join(DATA_DIR, "proactive")

COOLDOWN = 45 * 60
DAILY_MAX = 4
QUIET_START, QUIET_END = 8, 23  # 允许主动消息的时段（左闭右开）

_lock = threading.RLock()


def _path(space):
    return os.path.join(PROACTIVE_DIR, f"{normalize_space(space)}.json")


def _today():
    return datetime.now(CN_TZ).strftime("%Y-%m-%d")


def _load(space):
    state = {"last_ts": 0.0, "day": _today(), "day_count": 0, "last_text": ""}
    try:
        with open(_path(space), encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            state.update({k: v for k, v in saved.items() if k in state})
    except Exception:  # noqa: BLE001
        pass
    if state.get("day") != _today():
        state["day"] = _today()
        state["day_count"] = 0
    return state


def _save(space, state):
    atomic_write_json(_path(space), state)


def _clean(text):
    text = re.sub(r"^[\s\"'“”「」]+|[\s\"'“”「」]+$", "", str(text or ""))
    text = re.sub(r"^(好的|嗯)[，,。]?", "", text).strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return ""
    text = " ".join(lines[:2])
    return text[:60]


def _now_text(dt):
    weekdays = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
    return f"{dt.year}年{dt.month}月{dt.day}日 {weekdays[dt.weekday()]} {dt.strftime('%H:%M')}"


def maybe(space, card, messages, memories_block="", location=None):
    """尝试生成一条主动消息；不满足条件时返回 {"message": None, "reason": ...}。"""
    now_dt = datetime.now(CN_TZ)
    if not (QUIET_START <= now_dt.hour < QUIET_END):
        return {"message": None, "reason": "quiet-hours"}

    with _lock:
        state = _load(space)
        if state.get("day_count", 0) >= DAILY_MAX:
            return {"message": None, "reason": "daily-limit"}
        if time.time() - float(state.get("last_ts") or 0) < COOLDOWN:
            return {"message": None, "reason": "cooldown"}

    recent = []
    for m in (messages or [])[-8:]:
        if not isinstance(m, dict):
            continue
        text = str(m.get("content") or "").strip()[:200]
        if not text:
            continue
        recent.append(("他" if m.get("role") == "user" else "你") + f": {text}")
    convo = "\n".join(recent)

    system = (
        f"你正在扮演「{card['name']}」，人设：{card['persona']}\n"
        f"当前时间：{_now_text(now_dt)}。\n"
        "你的恋人有一阵子没回消息了。请主动发一条消息给他，像真人发微信那样："
        "一到两句话、不超过 40 字，可以问他在忙什么、说说你此刻在做什么、"
        "或者结合天气和之前聊过的事自然地关心他。"
        "不要质问、不要连续追问、不要用引号包裹，不要提 AI，不要用 Markdown 和表情符号，直接输出要发送的内容。"
    )
    if location:
        parts = [v for v in (location.get("city"), location.get("weather_text")) if v]
        if parts:
            system += "\n他所在的城市和实时天气：" + "，".join(parts) + "。"
    if memories_block:
        system += "\n\n【长期记忆】\n" + memories_block

    prompt = (f"你们最近的对话：\n{convo}\n\n" if convo else "") + "现在主动发一条消息："

    text = ""
    for budget in (600, 1200):
        raw = router.chat(
            [{"role": "user", "content": prompt}],
            system, route="light", max_tokens=budget,
        ) or ""
        text = _clean(raw)
        if text:
            break
    if not text:
        return {"message": None, "reason": "empty"}

    with _lock:
        state = _load(space)
        state["last_ts"] = time.time()
        state["day_count"] = int(state.get("day_count") or 0) + 1
        state["last_text"] = text
        _save(space, state)

    return {"message": text, "reason": "sent"}
