"""长期记忆：抽取（轻量模型）→ 存储 → 检索 → 注入 prompt。

记忆类型与权重：
- correction 用户纠正（「我不吃辣」推翻旧偏好）权重最高，入库时覆盖旧记忆
- preference 用户偏好（喜欢/讨厌/习惯）
- event 重要事件（生日、搬家、生病……）
- emotion 情绪状态（近期低落/开心，供共情参考）

存储：data/memories/<space>.json（space 按角色区分）。
检索：字符 2-gram Jaccard 重合度 × 类型权重 + 时间新近度（无向量库的轻量方案）。
"""
import json
import os
import re
import threading
import time
import uuid

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
MEM_DIR = os.path.join(DATA_DIR, "memories")

TYPE_WEIGHT = {"correction": 3.0, "preference": 2.2, "event": 1.6, "emotion": 1.2}
VALID_TYPES = set(TYPE_WEIGHT)
_MAX_ITEMS = 200          # 单个 space 的记忆条数上限
_ngram_cache = {}         # 文本 → 2-gram 集合（进程内复用）
_lock = threading.RLock()  # 可重入：add() 持锁期间调用 _save() 会再次申请同一把锁


def _tokens(text):
    """中文文本 → 字符 2-gram 集合（含 ASCII 词），用于相似度与重合度计算。"""
    cached = _ngram_cache.get(text)
    if cached is not None:
        return cached
    text = re.sub(r"\s+", "", str(text).lower())
    words = re.findall(r"[a-z0-9]+", text)
    grams = set(words)
    for i in range(len(text) - 1):
        grams.add(text[i:i + 2])
    if len(grams) > 512:  # 超长文本截断，防缓存膨胀
        grams = set(list(grams)[:512])
    _ngram_cache[text] = grams
    if len(_ngram_cache) > 2000:  # 简单防膨胀
        _ngram_cache.clear()
    return grams


def _jaccard(a, b):
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


class MemoryStore:
    def __init__(self, space="default"):
        self.space = re.sub(r"[^\w\-]", "_", space)[:40] or "default"
        self.path = os.path.join(MEM_DIR, f"{self.space}.json")
        self.items = []
        self._load()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            self.items = [m for m in data if isinstance(m, dict) and m.get("content")]
        except Exception:  # noqa: BLE001
            self.items = []

    def _save(self):
        os.makedirs(MEM_DIR, exist_ok=True)
        tmp = self.path + ".tmp"
        with _lock:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.items, f, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)

    def add(self, mtype, content, source="chat"):
        """新增记忆；与旧记忆高度相似时视为同一条（触碰刷新），否则追加。"""
        mtype = mtype if mtype in VALID_TYPES else "event"
        content = re.sub(r"\s+", " ", str(content)).strip()[:200]
        if not content:
            return None
        grams = _tokens(content)
        now = time.time()
        with _lock:
            for m in self.items:
                g_old = _tokens(m["content"])
                inter = len(g_old & grams)
                contain = inter / max(1, min(len(g_old), len(grams)))
                if _jaccard(g_old, grams) >= 0.5 or contain >= 0.65:
                    m["ts"] = now  # 触碰即视为仍然有效（同一条事实的不同说法）
                    self._save()
                    return m["id"]
            m = {"id": uuid.uuid4().hex[:10], "type": mtype, "content": content,
                 "ts": now, "source": source}
            self.items.append(m)
            if len(self.items) > _MAX_ITEMS:  # 淘汰最旧的非纠正记忆
                victims = sorted(
                    (m for m in self.items if m["type"] != "correction"),
                    key=lambda m: m["ts"],
                )
                for v in victims[: len(self.items) - _MAX_ITEMS]:
                    self.items.remove(v)
            self._save()
            return m["id"]

    def _drop_similar_locked(self, text, threshold=0.5):
        """删除与 text 相似的旧记忆（调用方须已持锁）。"""
        grams = _tokens(text)
        kept = []
        removed = 0
        for m in self.items:
            g_old = _tokens(m["content"])
            inter = len(g_old & grams)
            contain = inter / max(1, min(len(g_old), len(grams)))
            if _jaccard(g_old, grams) >= threshold or contain >= threshold:
                removed += 1
                continue
            kept.append(m)
        self.items = kept
        return removed

    def add_all(self, memories, source="chat"):
        """批量入库。条目可带 obsolete（被本轮推翻的旧记忆原文），
        入库前先按原文删除旧条，保证纠正真正生效。"""
        ids = []
        changed = False
        for m in memories or []:
            if not isinstance(m, dict):
                continue
            try:
                with _lock:
                    obsolete = re.sub(r"\s+", " ", str(m.get("obsolete") or "")).strip()
                    if obsolete:
                        if self._drop_similar_locked(obsolete):
                            changed = True
                mid = self.add(m.get("type", "correction") if obsolete else m.get("type", "event"),
                               m.get("content", ""), source)
                if mid:
                    ids.append(mid)
                    changed = True
            except Exception:  # noqa: BLE001
                pass
        if changed:
            self._save()
        return ids

    def delete(self, mid):
        with _lock:
            before = len(self.items)
            self.items = [m for m in self.items if m.get("id") != mid]
            changed = len(self.items) != before
        if changed:
            self._save()
        return changed

    def search(self, query, k=6):
        """按「重合度×类型权重 + 新近度」取 top-k。"""
        q = _tokens(query)
        now = time.time()
        scored = []
        for m in self.items:
            overlap = _jaccard(q, _tokens(m["content"]))
            recency = max(0.0, 1.0 - (now - m["ts"]) / (30 * 86400)) * 0.6
            score = overlap * TYPE_WEIGHT.get(m["type"], 1.0) + recency
            if score <= 0.05:
                continue
            scored.append((score, m))
        scored.sort(key=lambda pair: -pair[0])
        return [m for _, m in scored[:k]]

    def to_prompt(self, memories):
        if not memories:
            return ""
        labels = {"correction": "纠正", "preference": "偏好", "event": "事件", "emotion": "情绪"}
        lines = [f"- [{labels.get(m['type'], '备注')}] {m['content']}" for m in memories]
        return "\n".join(lines)


# ============ 记忆抽取（轻量模型，路由 light） ============
EXTRACT_SYSTEM = (
    "你是记忆抽取器。从对话片段中提取值得长期记住的「用户侧」信息。"
    "只输出 JSON 数组，不要输出任何其他文字。每条格式："
    '{"type": "preference|correction|event|emotion", "content": "一句话，以用户为主语"}。'
    "preference=喜好/习惯（如：不吃辣、喜欢周杰伦）；"
    "correction=用户推翻了已有认知（此时必须带 \"obsolete\": 被推翻的旧记忆原文，从已知记忆清单里原样复制）；"
    "event=重要事件（生日/搬家/考试/生病等）；"
    "emotion=明显且持续的情绪状态（如：最近因工作低落）。"
    "若本轮对话只是闲聊、没有新信息，输出 []。最多 4 条。泛泛的寒暄不要记。"
)


def extract_memories(user_text, assistant_text, history_tail=None, existing=None):
    """调用 light 路由抽取记忆。existing 为已知记忆内容列表（供纠正判断）。
    成功返回列表（可为空=无需记）；调用/解析失败返回 None。"""
    from agent import router as _router

    history = ""
    for m in (history_tail or [])[-4:]:
        history += f"{'用户' if m.get('role') == 'user' else '角色'}: {str(m.get('content', ''))[:120]}\n"
    user_text = str(user_text or "")[:500]
    assistant_text = str(assistant_text or "")[:500]
    if len(user_text) < 4:
        return []
    known = ""
    items = [str(x).strip()[:120] for x in (existing or []) if str(x).strip()]
    if items:
        known = "已知记忆清单：\n" + "\n".join(f"- {t}" for t in items) + "\n\n"
    prompt = f"{known}{history}用户: {user_text}\n角色: {assistant_text}\n\n提取记忆 JSON："
    try:
        raw = _router.chat(
            [{"role": "user", "content": prompt}],
            EXTRACT_SYSTEM,
            route="light",
            max_tokens=800,  # GLM 默认开 thinking，思考也占 token 预算
        )
        raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.M).strip()
        start, end = raw.find("["), raw.rfind("]")
        if start < 0 or end <= start:
            return []
        data = json.loads(raw[start:end + 1])
        return data if isinstance(data, list) else []
    except Exception as e:  # noqa: BLE001
        print(f"[memory] 抽取调用失败: {type(e).__name__}: {str(e)[:120]}", flush=True)
        return None
