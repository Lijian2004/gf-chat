"""她会发照片：即梦（Dreamina）图生图，用参考图锁定人物脸型，结果下载到本地。

- 首次生成时创建画布并上传参考图（data/ref/*.png），projectId / resourceId 持久化复用
- 每次生成调 dreamina-canvas CLI 的 i2i 模式，把结果下载到 static/generated/
- 参考图是用户私人物料，data/ 已在 .gitignore 中，不会提交到 git

环境变量：
- PHOTO_MODEL     生图模型（默认 seedream_4.7）
- PHOTO_RATIO     图片比例（默认 3:4）
- PHOTO_RESOLUTION 分辨率（默认 2K）
"""
import hashlib
import json
import os
import subprocess
import threading
import time

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEN_DIR = os.path.join(BASE_DIR, "static", "generated")
REF_DIR = os.path.join(BASE_DIR, "data", "ref")
STATE_PATH = os.path.join(BASE_DIR, "data", "photo_state.json")

CLI = "dreamina-canvas"
MODEL = os.environ.get("PHOTO_MODEL", "seedream_4.7")
RATIO = os.environ.get("PHOTO_RATIO", "3:4")
RESOLUTION = os.environ.get("PHOTO_RESOLUTION", "2K")
CLI_TIMEOUT = 360  # 单次 CLI 调用超时（秒）：生成 + 下载

_lock = threading.Lock()
_state = None  # {"project_id": str, "ref_resource_ids": [str, ...]}
_available_cache = None  # (timestamp, bool)：available() 结果缓存


def _cli(*args, timeout=CLI_TIMEOUT):
    """调用 dreamina-canvas CLI，返回解析后的 data dict；失败抛 RuntimeError。"""
    try:
        proc = subprocess.run(
            [CLI, *args, "--format", "json"],
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="ignore",
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("生图超时，请稍后重试")
    except FileNotFoundError:
        raise RuntimeError("未安装 dreamina-canvas CLI")
    out = (proc.stdout or "").strip()
    try:
        data = json.loads(out)
    except ValueError:
        raise RuntimeError(f"CLI 输出无法解析：{out[:160]}")
    if not data.get("ok"):
        err = data.get("error") or {}
        detail = ""
        for d in err.get("diagnostics") or []:
            if d.get("detail"):
                detail = d["detail"]
                break
        raise RuntimeError(f"{err.get('message') or '调用失败'} {detail}".strip())
    return data.get("data") or {}


def _load_state():
    global _state
    if _state is not None:
        return _state
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            _state = json.load(f)
    except Exception:  # noqa: BLE001
        _state = {}
    return _state


def _save_state():
    global _state
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_state, f)
    os.replace(tmp, STATE_PATH)


def available():
    """是否可用：已安装 CLI 且已登录。结果缓存 5 分钟，避免每次请求 subprocess。"""
    global _available_cache
    now = time.time()
    if _available_cache is not None and now - _available_cache[0] < 300:
        return _available_cache[1]
    try:
        data = _cli("auth", "status", timeout=30)
        ok = bool(data.get("loggedIn"))
    except Exception:  # noqa: BLE001
        ok = False
    _available_cache = (now, ok)
    return ok


def _ref_images():
    """参考图文件路径列表（按文件名排序）。"""
    if not os.path.isdir(REF_DIR):
        return []
    return sorted(
        os.path.join(REF_DIR, fn)
        for fn in os.listdir(REF_DIR)
        if fn.lower().endswith((".png", ".jpg", ".jpeg"))
    )


def _ensure_ready():
    """确保画布与参考图已就绪，返回 (project_id, ref_resource_ids)。"""
    state = _load_state()
    project_id = state.get("project_id")
    ref_ids = list(state.get("ref_resource_ids") or [])

    if not project_id:
        data = _cli("canvas", "create", "AI女友发照片", "--use")
        project_id = (data.get("project") or {}).get("projectId")
        if not project_id:
            raise RuntimeError("创建画布失败")
        state["project_id"] = project_id
        state["ref_resource_ids"] = []
        _save_state()

    refs = _ref_images()
    if not refs:
        raise RuntimeError("未找到参考图（data/ref/ 目录为空）")

    # 参考图数量/内容变化时重新上传全部（简单可靠）
    if len(ref_ids) != len(refs):
        ref_ids = []
        for i, path in enumerate(refs):
            data = _cli(
                "resource", "upload", "--file", path,
                "--project-id", project_id, "--type", "image",
                "--name", f"参考图{i + 1}",
            )
            rid = data.get("resourceId")
            if not rid:
                raise RuntimeError("上传参考图失败")
            ref_ids.append(rid)
        state["ref_resource_ids"] = ref_ids
        _save_state()

    return project_id, ref_ids


def _build_prompt(scene):
    return (
        "参考图只用来锁定这位女生的脸和发型，服装必须根据新场景重新合理搭配，"
        "不要照搬参考图里的服装。"
        "室内场景穿轻薄舒适的居家/休闲装（衬衫、针织衫、连衣裙、T恤等），"
        "不要穿羽绒服、围巾、厚外套等冬季厚重服装；只有寒冷户外场景才穿冬装。"
        f"新画面：{scene}。真实摄影质感，自然光，浅景深。"
    )


def generate(scene, force=False):
    """按场景描述图生图，返回 {url, scene, cached}。"""
    scene = str(scene or "").strip()[:200]
    if not scene:
        raise ValueError("画面描述不能为空")

    prompt = _build_prompt(scene)
    digest = hashlib.sha1(prompt.encode("utf-8")).hexdigest()[:16]
    filename = f"{digest}.png"
    path = os.path.join(GEN_DIR, filename)
    url = f"/static/generated/{filename}"

    with _lock:
        if not force and os.path.exists(path) and os.path.getsize(path) > 0:
            return {"url": url, "scene": scene, "cached": True}

        project_id, ref_ids = _ensure_ready()
        ref_args = []
        for rid in ref_ids:
            ref_args += ["--ref", f"res:{rid}"]

        data = _cli(
            "node", "create", "image",
            "--project-id", project_id,
            "--mode", "i2i",
            "--model", MODEL,
            *ref_args,
            "--prompt", prompt,
            "--ratio", RATIO,
            "--resolution", RESOLUTION,
            "--title", scene[:20] or "照片",
            "--run", "--wait", "--timeout", "5m",
        )

        submission = data.get("submission") or {}
        resources = submission.get("resources") or []
        if not resources:
            raise RuntimeError("生成未返回结果")
        result_rid = resources[0].get("resourceId")
        if not result_rid:
            raise RuntimeError("生成结果缺少 resourceId")

        os.makedirs(GEN_DIR, exist_ok=True)
        _cli(
            "resource", "download", result_rid,
            "--project-id", project_id, "-o", path,
        )

        return {"url": url, "scene": scene, "cached": False, "ts": time.time()}
