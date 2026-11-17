"""她的日记与「她眼中的你」：把对话与长期记忆转成角色视角的文字。

- 日记：每天一篇，第一人称，记录当天相处的细节与感受（light 路由）
- 她眼中的你：根据长期记忆生成画像，按记忆内容哈希缓存，记忆不变不重复生成
存储：data/diary/<space>.json = {"entries": [...], "profile": {...}}
"""
import hashlib
import json
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    CN_TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # noqa: BLE001
    CN_TZ = timezone(timedelta(hours=8))

from agent import router
from agent.memory import normalize_space
from agent.textproc import atomic_write_json, parse_llm_json

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DIARY_DIR = os.path.join(DATA_DIR, "diary")
_MAX_ENTRIES = 60

_lock = threading.RLock()

DIARY_SYSTEM = (
    "你现在跳出对话，用角色本人的第一人称写今天的私人日记。"
    "只写今天和他相处时的细节、他说过的话、你真实的情绪起伏，像真人睡前写日记。"
    "80-150 字，口语化，不要列表、标题、Markdown、表情符号。"
    "只输出 JSON，格式："
    '{"mood": "两到四个字的心情", "text": "日记正文", '
    '"highlights": ["今天最在意的1-3件事，每条不超过20字"]}'
)

PROFILE_SYSTEM = (
    "你是一个温柔细心的人，正在写下你眼中的他。"
    "根据给出的长期记忆，用第二人称「你」写 80-120 字：他的喜好、习惯、"
    "最近的状态，以及你观察到的、他自己可能没注意到的细节。"
    "像在心里默默想他，不要列表、标题、Markdown，不要编造记忆里没有的信息。"
    "直接输出正文。"
)


def _path(space):
    return os.path.join(DIARY_DIR, f"{normalize_space(space)}.json")


def _today():
    return datetime.now(CN_TZ).strftime("%Y-%m-%d")


def _load(space):
    try:
        with open(_path(space), encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            data.setdefault("entries", [])
            data.setdefault("profile", None)
            return data
    except Exception:  # noqa: BLE001
        pass
    return {"entries": [], "profile": None}


def _save(space, data):
    atomic_write_json(_path(space), data)


def list_entries(space):
    data = _load(space)
    entries = sorted(data.get("entries") or [], key=lambda e: e.get("ts", 0), reverse=True)
    return entries[:_MAX_ENTRIES]


def get_entry(space, date_str=None):
    date_str = date_str or _today()
    for e in _load(space).get("entries") or []:
        if e.get("date") == date_str:
            return e
    return None


def _convo(messages, limit=40):
    lines = []
    for m in (messages or [])[-limit:]:
        if not isinstance(m, dict):
            continue
        text = str(m.get("content") or "").strip()[:300]
        if not text:
            continue
        lines.append(("用户" if m.get("role") == "user" else "你") + f": {text}")
    return "\n".join(lines)


def generate(space, card, messages, date_str=None, force=False):
    """生成（或返回已有）某天的日记。"""
    date_str = date_str or _today()
    if not force:
        existing = get_entry(space, date_str)
        if existing:
            return {**existing, "existing": True}

    convo = _convo(messages)
    if not convo:
        raise ValueError("今天还没有可以写进日记的对话")

    system = (
        f"你正在扮演「{card['name']}」，人设：{card['persona']}\n"
        + DIARY_SYSTEM
    )
    prompt = f"今天的对话：\n{convo}\n\n请以你的身份写今天的日记："

    data = None
    last_err = None
    for budget in (1200, 2400):
        raw = router.chat(
            [{"role": "user", "content": prompt}],
            system, route="light", max_tokens=budget,
        ) or ""
        try:
            data = parse_llm_json(raw, "{", "}")
            break
        except ValueError as e:
            last_err = e
    if data is None:
        raise ValueError(f"日记生成失败：{last_err}")

    text = str(data.get("text") or "").strip()
    if not text:
        raise ValueError("日记内容为空")

    entry = {
        "id": uuid.uuid4().hex[:10],
        "date": date_str,
        "mood": str(data.get("mood") or "").strip()[:8],
        "text": text[:800],
        "highlights": [
            str(h).strip()[:40] for h in (data.get("highlights") or []) if str(h).strip()
        ][:3],
        "ts": time.time(),
    }

    with _lock:
        data_all = _load(space)
        entries = [e for e in data_all.get("entries") or [] if e.get("date") != date_str]
        entries.append(entry)
        entries.sort(key=lambda e: e.get("ts", 0))
        data_all["entries"] = entries[-_MAX_ENTRIES:]
        _save(space, data_all)
    return entry


def profile(space, card, memories, force=False):
    """「她眼中的你」：长期记忆不变时复用缓存。"""
    texts = [str(m).strip()[:120] for m in (memories or []) if str(m).strip()]
    if not texts:
        return {"text": "", "ts": None, "cached": False}

    digest = hashlib.sha1("\n".join(texts).encode("utf-8")).hexdigest()
    data = _load(space)
    cached = data.get("profile") or {}
    if not force and cached.get("hash") == digest and cached.get("text"):
        return {"text": cached["text"], "ts": cached.get("ts"), "cached": True}

    system = f"你正在扮演「{card['name']}」，人设：{card['persona']}\n" + PROFILE_SYSTEM
    prompt = "长期记忆：\n" + "\n".join(f"- {t}" for t in texts) + "\n\n你眼中的他："
    text = ""
    for budget in (800, 1600):
        raw = router.chat(
            [{"role": "user", "content": prompt}],
            system, route="light", max_tokens=budget,
        ) or ""
        text = raw.strip().strip('"“”')
        if text:
            break
    if not text:
        return {"text": "", "ts": None, "cached": False}

    with _lock:
        data = _load(space)
        data["profile"] = {"hash": digest, "text": text[:600], "ts": time.time()}
        _save(space, data)
    return {"text": text[:600], "ts": time.time(), "cached": False}
