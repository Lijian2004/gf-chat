"""轻量 RAG：用户上传日记/聊天记录 → 分块 → BM25 索引 → 检索注入对话。

纯 Python 实现，无外部依赖、无向量库：
- 分块：500 字/块，50 字重叠，按段落边界优先切分
- 索引：倒排索引 + BM25 (k1=1.5, b=0.75)，词元用字符 2-gram（中文友好）
- 存储：data/docs/<space>.json（文档与块一并持久化，启动时重建内存索引）
"""
import json
import math
import os
import re
import threading
import time
import uuid

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DOCS_DIR = os.path.join(DATA_DIR, "docs")

CHUNK_SIZE = 500
CHUNK_OVERLAP = 50
_MAX_DOCS = 50       # 每个 space 文档数上限
_MAX_CHUNKS = 2000   # 每个 space 总块数上限
_K1, _B = 1.5, 0.75
_lock = threading.Lock()


def _terms(text):
    """中文 2-gram + ASCII 词（与 memory 模块同一套词元方案）。"""
    text = re.sub(r"\s+", " ", str(text).lower())
    out = re.findall(r"[a-z0-9]+", text)
    compact = text.replace(" ", "")
    for i in range(len(compact) - 1):
        out.append(compact[i:i + 2])
    return out


def _chunk_text(text):
    """按段落优先切分为带重叠的块。"""
    text = re.sub(r"\r\n?", "\n", str(text)).strip()
    if not text:
        return []
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    # 先按段落聚到 ~CHUNK_SIZE
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
        self.space = re.sub(r"[^\w\-]", "_", space)[:40] or "default"
        self.path = os.path.join(DOCS_DIR, f"{self.space}.json")
        self.docs = []   # [{id, name, ts, chunks: [{id, doc_id, name, text}]}]
        self._index = None  # {term: [chunk_idx]}，懒构建
        self._df = None
        self._load()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                self.docs = json.load(f)
        except Exception:  # noqa: BLE001
            self.docs = []
        self._index = None

    def _save(self):
        os.makedirs(DOCS_DIR, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.docs, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def _all_chunks(self):
        return [c for d in self.docs for c in d["chunks"]]

    def _build_index(self):
        chunks = self._all_chunks()
        self._index, self._df = {}, {}
        for idx, c in enumerate(chunks):
            for t in set(_terms(c["text"])):
                self._index.setdefault(t, []).append(idx)
                self._df[t] = self._df.get(t, 0) + 1
        self._n = max(1, len(chunks))

    def _invalidate(self):
        self._index = None

    def add_doc(self, name, text):
        chunks = _chunk_text(text)
        if not chunks:
            raise ValueError("文档内容为空")
        with _lock:
            # 同名文档覆盖
            self.docs = [d for d in self.docs if d["name"] != name]
            doc = {
                "id": uuid.uuid4().hex[:10],
                "name": str(name).strip()[:100],
                "ts": time.time(),
                "chunks": [
                    {"id": f"{uuid.uuid4().hex[:8]}{i}", "text": c}
                    for i, c in enumerate(chunks)
                ],
            }
            doc["chunks"] = [{"id": doc["id"] + f"c{i}", "text": c} for i, c in enumerate(chunks)]
            self.docs.append(doc)
            total = len(self._all_chunks())
            if len(self.docs) > _MAX_DOCS or total > _MAX_CHUNKS:
                # 淘汰最旧文档直到不超限
                self.docs.sort(key=lambda d: d["ts"])
                while self.docs and (len(self.docs) > _MAX_DOCS or len(self._all_chunks()) > _MAX_CHUNKS):
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
            chunks = self._all_chunks()
            if not chunks or not self._index:
                return []
            q_terms = _terms(query)
            scores = {}
            for t in set(q_terms):
                postings = self._index.get(t)
                if not postings:
                    continue
                idf = math.log(1 + (self._n - len(postings) + 0.5) / (len(postings) + 0.5))
                for idx in postings:
                    tf = _terms(chunks[idx]["text"]).count(t)
                    if not tf:
                        continue
                    dl = len(chunks[idx]["text"])
                    denom = tf + _K1 * (1 - _B + _B * dl / 400)
                    scores[idx] = scores.get(idx, 0.0) + idf * tf * (_K1 + 1) / denom
            top = sorted(scores.items(), key=lambda kv: -kv[1])[:k]
            return [
                {"text": chunks[idx]["text"], "name": chunks[idx].get("name", "") or "",
                 "score": round(s, 3)}
                for idx, s in top
            ]

    def to_prompt(self, hits):
        if not hits:
            return ""
        parts = [f"《{h['name']}》：{h['text'][:300]}" for h in hits]
        return "\n---\n".join(parts)
