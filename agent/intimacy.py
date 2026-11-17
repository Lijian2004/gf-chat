"""亲密度系统：好感值累积、关系等级与语气提示。

好感来源：
- 完成一轮对话 +1（当日对话加分上限 30，防刷）
- 抽取出新记忆 +1/条（单轮最多 +3），纠正类 +3
- 隔天回来 +5（距上次互动超过 12 小时）
等级：Lv.1 初识 → 熟悉 → 亲近 → 亲密 → 恋人 → 灵魂伴侣
存储：data/intimacy/<space>.json（按角色区分，与记忆空间同名）
"""
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    CN_TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # noqa: BLE001  tzdata 缺失时退回固定 +8
    CN_TZ = timezone(timedelta(hours=8))

from agent.memory import normalize_space
from agent.textproc import atomic_write_json

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
INTIMACY_DIR = os.path.join(DATA_DIR, "intimacy")

DAILY_TURN_CAP = 30     # 每日对话加分上限
RETURN_BONUS = 5        # 隔天回来奖励
RETURN_GAP = 12 * 3600  # 「隔天」判定间隔

# (门槛分数, 等级名, 语气提示, 称呼提示)
LEVELS = [
    (0, "初识", "你们刚认识，语气礼貌自然，保持一点距离感，不要过分亲昵。", "用「你」称呼，不要起昵称"),
    (30, "熟悉", "你们已经聊过不少，语气轻松自然，可以开点小玩笑。", "用「你」称呼，偶尔可以打趣"),
    (80, "亲近", "你们关系亲近，语气亲昵，会自然关心他的作息、吃饭和情绪。", "可以偶尔用玩笑式的昵称"),
    (160, "亲密", "你们非常亲密，会直接表达想念和喜欢，也会撒一点娇。", "可以用「亲爱的」这类亲昵称呼"),
    (300, "恋人", "你们是恋人关系，说话黏人、会撒娇、爱分享日常小事。", "可以自然地叫「宝贝」"),
    (520, "灵魂伴侣", "你们是彼此最信任的人，语气笃定温柔，像相处很久的伴侣一样有默契。", "亲昵称呼可以随情绪自然使用"),
]

_lock = threading.RLock()
_store_cache = {}  # space -> data dict


def _path(space):
    return os.path.join(INTIMACY_DIR, f"{normalize_space(space)}.json")


def _today():
    return datetime.now(CN_TZ).strftime("%Y-%m-%d")


def _blank(space):
    now = time.time()
    return {
        "space": normalize_space(space),
        "score": 0,
        "created": now,
        "last_ts": 0.0,
        "day": _today(),
        "day_gain": 0,
        "milestones": [],
    }


def _load(space):
    data = _blank(space)
    try:
        with open(_path(space), encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            data.update({k: v for k, v in saved.items() if k in data})
    except Exception:  # noqa: BLE001
        pass
    # 跨天重置当日加分
    if data.get("day") != _today():
        data["day"] = _today()
        data["day_gain"] = 0
    return data


def _save(space, data):
    atomic_write_json(_path(space), data)


def _get(space):
    key = normalize_space(space)
    with _lock:
        data = _store_cache.get(key)
        if data is None:
            data = _load(key)
            _store_cache[key] = data
        return data


def _level_index(score):
    idx = 0
    for i, (min_score, *_rest) in enumerate(LEVELS):
        if score >= min_score:
            idx = i
    return idx


def info(space):
    """关系状态：分数、等级、进度、称呼提示、里程碑。"""
    data = _get(space)
    score = int(data.get("score") or 0)
    idx = _level_index(score)
    min_score, name, hint, address = LEVELS[idx]
    next_min = LEVELS[idx + 1][0] if idx + 1 < len(LEVELS) else None
    if next_min is None:
        progress = 1.0
    else:
        span = max(1, next_min - min_score)
        progress = round(min(1.0, max(0.0, (score - min_score) / span)), 4)
    return {
        "score": score,
        "level": idx + 1,
        "level_name": name,
        "level_hint": hint,
        "address": address,
        "next": next_min,
        "to_next": max(0, (next_min - score)) if next_min else 0,
        "progress": progress,
        "created": data.get("created"),
        "milestones": data.get("milestones") or [],
    }


def add(space, delta, reason="chat", cap_daily=True):
    """加分。cap_daily=True 时受当日对话加分上限约束。返回最新 info。"""
    if delta <= 0:
        return info(space)
    data = _get(space)
    today = _today()
    with _lock:
        if data.get("day") != today:
            data["day"] = today
            data["day_gain"] = 0
        if cap_daily:
            remain = max(0, DAILY_TURN_CAP - int(data.get("day_gain") or 0))
            delta = min(delta, remain)
            if delta <= 0:
                return info(space)
        before = _level_index(int(data.get("score") or 0))
        data["score"] = int(data.get("score") or 0) + delta
        data["day_gain"] = int(data.get("day_gain") or 0) + delta
        data["last_ts"] = time.time()
        after = _level_index(data["score"])
        if after > before:
            milestones = data.setdefault("milestones", [])
            for i in range(before + 1, after + 1):
                milestones.append({
                    "ts": time.time(),
                    "level": i + 1,
                    "name": LEVELS[i][1],
                    "reason": reason,
                })
            del milestones[:-30]  # 只保留最近 30 条升级记录
        _save(space, data)
    return info(space)


def add_turn(space):
    """完成一轮对话：基础 +1；久未互动回来额外 +5。"""
    data = _get(space)
    now = time.time()
    last = float(data.get("last_ts") or 0)
    delta = 1
    if last and now - last >= RETURN_GAP:
        delta += RETURN_BONUS
    return add(space, delta, "chat" if delta == 1 else "return")


def prompt_block(space):
    """注入 system prompt 的关系描述（等级 + 语气 + 称呼）。"""
    st = info(space)
    return (
        f"你和他现在是「{st['level_name']}」关系（Lv.{st['level']}，好感 {st['score']}）。"
        f"{st['level_hint']} 对他的称呼：{st['address']}。"
    )
