"""多模型路由器：按任务类型选模型，故障自动沿链条降级。

- chat 路由（主力对话）：deepseek-v4-pro → GLM-5.3 → GLM-5.3-FlashX
- light 路由（记忆抽取/评估评审等轻任务）：GLM-5.3-Flash → GLM-5.3-FlashX → deepseek

provider 在 .env 中配置（key/base_url/model），缺 Key 的 provider 自动跳过。
流式输出中途失败无法无缝切换（已发出内容），仅在未输出前降级。
"""
import os
import threading

import anthropic

_PROVIDERS = {}
_lock = threading.Lock()


def _spec(name, key_var, base_var, model_var):
    key = os.environ.get(key_var, "").strip()
    base = os.environ.get(base_var, "").strip()
    model = os.environ.get(model_var, "").strip()
    if key and base and model:
        _PROVIDERS[name] = {"key": key, "base_url": base, "model": model, "client": None}


_spec("deepseek", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL")
_spec("bigmodel-flash", "BIGMODEL_API_KEY_1", "BIGMODEL_BASE_URL", "BIGMODEL_MODEL_FLASH")
_spec("bigmodel-flashx", "BIGMODEL_API_KEY_1", "BIGMODEL_BASE_URL", "BIGMODEL_MODEL_FLASHX")
_spec("bigmodel-pro", "BIGMODEL_API_KEY_2", "BIGMODEL_BASE_URL", "BIGMODEL_MODEL_PRO")

CHAT_CHAIN = [n for n in ("deepseek", "bigmodel-pro", "bigmodel-flashx") if n in _PROVIDERS]
LIGHT_CHAIN = [n for n in ("bigmodel-flash", "bigmodel-flashx", "deepseek") if n in _PROVIDERS]


def _client(provider):
    with _lock:
        if provider["client"] is None:
            provider["client"] = anthropic.Anthropic(
                api_key=provider["key"],
                base_url=provider["base_url"],
                max_retries=1,  # 路由链自带降级，SDK 内部不做长退避，避免叠加超时
            )
        return provider["client"]


def _chain(route):
    chain = CHAT_CHAIN if route == "chat" else LIGHT_CHAIN
    if not chain:
        raise RuntimeError("没有可用模型：请检查 .env 中的 API Key 配置")
    return chain


def chat(messages, system, route="chat", max_tokens=1024):
    """非流式调用（记忆抽取/评估评审），返回完整文本；失败沿链条降级。"""
    last_exc = None
    for name in _chain(route):
        p = _PROVIDERS[name]
        try:
            resp = _client(p).messages.create(
                model=p["model"],
                max_tokens=max_tokens,
                system=system,
                messages=messages,
            )
            return "".join(
                b.text for b in resp.content if getattr(b, "type", "") == "text"
            )
        except Exception as e:  # noqa: BLE001
            last_exc = e
    raise last_exc


def stream(messages, system, route="chat", max_tokens=8192):
    """流式生成器，逐段 yield 文本；首段输出前失败自动换下一个 provider。"""
    last_exc = None
    for name in _chain(route):
        p = _PROVIDERS[name]
        yielded = False
        try:
            with _client(p).messages.stream(
                model=p["model"],
                max_tokens=max_tokens,
                system=system,
                messages=messages,
            ) as s:
                for text in s.text_stream:
                    yielded = True
                    yield text
                return
        except Exception as e:  # noqa: BLE001
            if yielded:
                raise  # 已经发出内容，无法无缝换模型
            last_exc = e
    raise last_exc  # _chain() 保证链条非空，走到这里必有失败记录
