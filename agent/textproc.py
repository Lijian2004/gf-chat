"""共享文本处理工具：统一分词器、LLM JSON 解析、原子 JSON 落盘。

- tokenize/token_set：memory（相似度）与 rag（BM25）共用的中文 2-gram + ASCII 词方案，
  此前两个模块各有一份且实现漂移
- parse_llm_json：剥离代码围栏后截取首个 JSON 容器（light 模型爱包 ```json）
- atomic_write_json：tmp + os.replace，崩溃不会留下半截 JSON
"""
import json
import os
import re
import threading

_ngram_cache = {}
_ngram_lock = threading.Lock()
_NGRAM_CACHE_MAX = 2000


def tokenize(text):
    """中文 2-gram + ASCII 词，返回列表（rag 的 BM25 tf 需要保留重复项）。"""
    text = re.sub(r"\s+", " ", str(text).lower())
    words = re.findall(r"[a-z0-9]+", text)
    compact = text.replace(" ", "")
    for i in range(len(compact) - 1):
        words.append(compact[i:i + 2])
    return words


def token_set(text):
    """tokenize 的集合形式（带进程级缓存，供相似度计算）。"""
    cached = _ngram_cache.get(text)
    if cached is not None:
        return cached
    tokens = frozenset(tokenize(text))
    with _ngram_lock:
        if len(_ngram_cache) >= _NGRAM_CACHE_MAX:  # 淘汰最早的半数，避免整表清空
            for k in list(_ngram_cache)[:_NGRAM_CACHE_MAX // 2]:
                _ngram_cache.pop(k, None)
        _ngram_cache[text] = tokens
    return tokens


def parse_llm_json(raw, open_c="[", close_c="]"):
    """剥离 ``` 围栏后截取首个 JSON 容器并解析；失败抛出原异常。"""
    raw = re.sub(r"^```(json)?|```$", "", str(raw or "").strip(), flags=re.M).strip()
    start, end = raw.find(open_c), raw.rfind(close_c)
    if start < 0 or end <= start:
        raise ValueError(f"输出中找不到 JSON 容器 {open_c}{close_c}: {raw[:120]}")
    return json.loads(raw[start:end + 1])


def atomic_write_json(path, data):
    """原子写 JSON：先写临时文件再 replace，进程崩溃不会损坏原文件。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def jaccard(a, b):
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def containment(a, b):
    """|a∩b| / min(|a|,|b|)：短文本被长文本包含的比率。"""
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / max(1, min(len(a), len(b)))
