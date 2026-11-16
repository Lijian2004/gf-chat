"""轻量 RAG：用户上传日记/聊天记录 → 分块 → BM25 索引 → 检索注入对话。

纯 Python 实现，无外部依赖、无向量库：
- 分块：500 字/块，50 字重叠，按段落边界优先切分
- 索引：倒排索引 + BM25 (k1=1.5, b=0.75)，词元用 agent/textproc 的统一分词器（中文 2-gram）
- 存储：data/docs/<space>.json（文档与块一并持久化；索引在实例内懒构建，按 space 缓存实例）
"""
import json
import math
import os
import re
import threading
import time
import uuid

from agent.memory import normalize_space
from agent.textproc import atomic_write_json, tokenize

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DOCS_DIR = os.path.join(DATA_DIR, "docs")

CHUNK_SIZE = 500
CHUNK_OVERLAP = 50
_MAX_DOCS = 50       # 每个 space 文档数上限
_MAX_CHUNKS = 2000   # 每个 space 总块数上限
_K1, _B = 1.5, 0.75
_lock = threading.RLock()

_rag_cache = {}  # space -> RagStore（进程内复用，索引只建一次）


def _chunk_text(text):
    """按段落优先切分为带重叠的块。"""
    text = re.sub(r"\r\n?", "\n", str(text)).strip()
    if not text:
        return []
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    units, buf = [], ""
    for p in paras:
        while len(p) > CHUNK_SIZE:  # 单段超长：硬切
            units.append(p[:CHUNK_SIZE])
            p = p[CHUNK_SIZE - CHUNK_OVERLAP:]
        if buf and len(buf) + len(p) + 1 > CHUNK_SIZE:
            units.append(buf)
            buf = p
        else:
            buf = f"{buf}\n{p}".strip()
    if buf:
        units.append(buf)
    # 相邻块之间加重叠
    chunks = []
    for i, u in enumerate(units):
        if i > 0 and CHUNK_OVERLAP:
            tail = units[i - 1][-CHUNK_OVERLAP:]
            u = f"{tail}{u}"
        chunks.append(u[:CHUNK_SIZE + CHUNK_OVERLAP])
    return chunks


class RagStore:
    def __init__(self, space="default"):
        self.space = normalize_space(space)
        self.path = os.path.join(DOCS_DIR, f"{self.space}.json")
        self.docs = []   # [{id, name, ts, chunks: [{id, name, text}]}]
        self._index = None  # {term: [chunk_idx]}，懒构建
        self._tf = None     # [Counter]，构建时缓存各块词频（search 不再逐词重分词）
        self._len = None    # [块长度]
        self._load()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                self.docs = json.load(f)
        except Exception:  # noqa: BLE001
            self.docs = []
        self._invalidate()

    def _save(self):
        atomic_write_json(self.path, self.docs)

    def _all_chunks(self):
        return [c for d in self.docs for c in d["chunks"]]

    def _build_index(self):
        chunks = self._all_chunks()
        index, tf, length = {}, {}, {}
        for idx, c in enumerate(chunks):
            terms = tokenize(c["text"])
            length[idx] = len(c["text"])
            counts = {}
            for t in terms:
                counts[t] = counts.get(t, 0) + 1
            tf[idx] = counts
            for t in counts:
                index.setdefault(t, []).append(idx)
        self._index, self._tf, self._len = index, tf, length
        self._n = max(1, len(chunks))

    def _invalidate(self):
        self._index = None
        self._n = 0

    def add_doc(self, name, text):
        chunks = _chunk_text(text)
        if not chunks:
            raise ValueError("文档内容为空")
        doc_name = str(name).strip()[:100]
        with _lock:
            self.docs = [d for d in self.docs if d["name"] != doc_name]  # 同名覆盖
            doc = {
                "id": uuid.uuid4().hex[:10],
                "name": doc_name,
                "ts": time.time(),
                "chunks": [
                    {"id": f"{uuid.uuid4().hex[:8]}c{i}", "name": doc_name, "text": c}
                    for i, c in enumerate(chunks)
                ],
            }
            self.docs.append(doc)
            if len(self.docs) > _MAX_DOCS or len(self._all_chunks()) > _MAX_CHUNKS:
                # 淘汰最旧文档直到不超限（按块数递减）
                self.docs.sort(key=lambda d: d["ts"])
                while self.docs and (
                    len(self.docs) > _MAX_DOCS
                    or sum(len(d["chunks"]) for d in self.docs) > _MAX_CHUNKS
                ):
                    self.docs.pop(0)
            self._save()
            self._invalidate()
        return {"id": doc["id"], "name": doc["name"], "chunks": len(chunks)}

    def delete_doc(self, doc_id):
        with _lock:
            before = len(self.docs)
            self.docs = [d for d in self.docs if d["id"] != doc_id]
            changed = len(self.docs) != before
        if changed:
            self._save()
            self._invalidate()
        return changed

    def list_docs(self):
        return [
            {"id": d["id"], "name": d["name"], "ts": d["ts"], "chunks": len(d["chunks"])}
            for d in sorted(self.docs, key=lambda d: -d["ts"])
        ]

    def search(self, query, k=4):
        """BM25 检索，返回 [{text, name, score}]。索引/文档为空时返回 []。"""
        with _lock:
            if self._index is None:
                self._build_index()
            if not self._index:
                return []
            q_terms = set(tokenize(query))
            scores = {}
            for t in q_terms:
                postings = self._index.get(t)
                if not postings:
                    continue
                idf = math.log(1 + (self._n - len(postings) + 0.5) / (len(postings) + 0.5))
                for idx in postings:
                    tf = self._tf[idx].get(t, 0)
                    if not tf:
                        continue
                    denom = tf + _K1 * (1 - _B + _B * self._len[idx] / 400)
                    scores[idx] = scores.get(idx, 0.0) + idf * tf * (_K1 + 1) / denom
            chunks = self._all_chunks()
            top = sorted(scores.items(), key=lambda kv: -kv[1])[:k]
            return [
                {"text": chunks[idx]["text"], "name": chunks[idx].get("name", ""),
                 "score": round(s, 3)}
                for idx, s in top
            ]

    def to_prompt(self, hits):
        if not hits:
            return ""
        parts = [f"《{h['name']}》：{h['text'][:300]}" for h in hits]
        return "\n---\n".join(parts)


def get_rag_store(space):
    """按 space 取共享 RagStore 实例（索引跨请求复用，不每条消息重建）。"""
    key = normalize_space(space)
    with _lock:
        store = _rag_cache.get(key)
        if store is None:
            store = RagStore(key)
            _rag_cache[key] = store
        return store
