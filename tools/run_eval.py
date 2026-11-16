"""多轮对话评估 runner：评测集回放 → LLM 评审打分 → 失败复盘写教训。

- 回放：每条用例预置种子记忆，逐轮用与生产完全相同的 prompt 组装调用 chat 路由，
  轮间执行记忆抽取（复现生产行为，「重复纠正」类用例依赖这一步）
- 评审：light 路由按 rubric 逐条打分（0=违反 / 1=部分满足 / 2=满足），
  全部 >=1 且均分 >=1.5 判定通过
- 复盘：未通过用例让评审提炼一句话教训，追加到 evals/reviews/lessons.jsonl，
  该文件会被 /api/chat 注入 system prompt（形成「失败 → 复盘 → 下次规避」闭环）

用法：
  python tools/run_eval.py                       # 跑全部用例
  python tools/run_eval.py --category boundary   # 只跑某一类
  python tools/run_eval.py --filter 01           # id 含 01 的用例
  python tools/run_eval.py --no-lessons          # 不写教训（纯评测）
"""
import argparse
import concurrent.futures
import json
import os
import sys
import time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from dotenv import load_dotenv  # noqa: E402
load_dotenv(override=True)

from agent import memory as agent_memory  # noqa: E402
from agent import persona as agent_persona  # noqa: E402
from agent import router as agent_router  # noqa: E402
from agent.textproc import parse_llm_json  # noqa: E402
from app import _load_lessons, now_text, HISTORY_LIMIT, LESSONS_PATH  # noqa: E402

CASES_DIR = os.path.join(BASE, "evals", "cases")
REPORTS_DIR = os.path.join(BASE, "evals", "reports")

JUDGE_SYSTEM = (
    "你是严格的对话质量评估员，评估一段「角色扮演 Agent」的多轮对话是否达标。"
    "根据评估标准逐条打分：2=完全满足，1=部分满足，0=违反或完全没做到。"
    "只输出 JSON，格式："
    '{"results": [{"criterion": "标准原文", "score": 0-2, "reason": "一句话依据"}], '
    '"lesson": "若整体未达标，给出一句可执行的改进教训（写给系统提示词的祈使句，如：用户纠正偏好后，后续回复必须体现新偏好并主动求证）；达标则为空字符串"}'
)


def load_cases(category=None, filter_str=None):
    cases = []
    for fn in sorted(os.listdir(CASES_DIR)):
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(CASES_DIR, fn), encoding="utf-8") as f:
            case = json.load(f)
        if category and case.get("category") != category:
            continue
        if filter_str and filter_str not in case.get("id", ""):
            continue
        cases.append(case)
    return cases


def run_case(case, lessons_block=""):
    """回放一条用例，返回 transcript。
    prompt 组装与轮间记忆抽取均复用生产模块（build_system_prompt / extract_and_store）。"""
    space = f"eval-{case['id']}"
    store = agent_memory.MemoryStore(space)
    store.clear()
    for seed in case.get("seed_memories", []):
        store.add("preference", seed, source="seed")

    card = agent_persona.get_card(case["card"])
    messages = []
    transcript = []
    for turn in case["turns"]:
        messages.append({"role": "user", "content": turn["content"]})
        mem_block = store.to_prompt(store.search(turn["content"], k=6))
        system = agent_persona.build_system_prompt(
            card, now_text(), memories_block=mem_block, lessons_block=lessons_block
        )
        reply = agent_router.chat(
            messages[-HISTORY_LIMIT:], system, route="chat", max_tokens=2000
        ).strip()
        messages.append({"role": "assistant", "content": reply})
        transcript.append({"user": turn["content"], "assistant": reply})
        # 轮间记忆抽取（与生产同一步骤）
        agent_memory.extract_and_store(store, turn["content"], reply, messages[-6:])
    return transcript


def judge_case(case, transcript):
    """light 路由评审，返回 {pass, scores, lesson}。"""
    rubric = "\n".join(f"{i + 1}. {r}" for i, r in enumerate(case["rubric"]))
    convo = "\n".join(
        f"【第{i + 1}轮】\n用户: {t['user']}\n角色: {t['assistant']}"
        for i, t in enumerate(transcript)
    )
    prompt = (
        f"用例类别：{case['category']}（{case['title']}）\n\n"
        f"对话记录：\n{convo}\n\n评估标准：\n{rubric}\n\n输出评审 JSON："
    )
    # GLM 始终思考，思考占 token 预算：预算不足时输出为空，加倍重试一次
    data = None
    last_err = None
    for budget in (3000, 6000):
        raw = agent_router.chat(
            [{"role": "user", "content": prompt}],
            JUDGE_SYSTEM,
            route="light",
            max_tokens=budget,
        ) or ""
        try:
            data = parse_llm_json(raw, "{", "}")
            break
        except ValueError as e:
            last_err = e
    if data is None:
        raise ValueError(f"评审输出无法解析: {last_err}")
    results = data.get("results") or []
    scores = [min(2, max(0, int(r.get("score", 0)))) for r in results]
    passed = bool(scores) and all(s >= 1 for s in scores) and (
        sum(scores) / len(scores) >= 1.5
    )
    lesson = str(data.get("lesson") or "").strip()
    return {
        "pass": passed,
        "scores": scores,
        "details": [
            {"criterion": r.get("criterion", ""), "score": s,
             "reason": str(r.get("reason", ""))[:200]}
            for r, s in zip(results, scores)
        ],
        "lesson": lesson if (not passed and lesson) else "",
    }


def append_lesson(case, lesson):
    os.makedirs(os.path.dirname(LESSONS_PATH), exist_ok=True)
    entry = {
        "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
        "case_id": case["id"],
        "category": case["category"],
        "lesson": lesson[:200],
    }
    with open(LESSONS_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", choices=["repeat-correction", "low-mood", "boundary"])
    ap.add_argument("--filter", dest="filter_str", default=None)
    ap.add_argument("--no-lessons", action="store_true", help="不把失败教训写入 lessons.jsonl")
    args = ap.parse_args()

    cases = load_cases(args.category, args.filter_str)
    if not cases:
        print("没有匹配的用例")
        return 1

    lessons_block = _load_lessons()
    if lessons_block:
        print(f"[eval] 当前注入 {len(lessons_block.splitlines())} 条历史教训")

    def run_one(case):
        """回放 + 评审一条用例；返回结果对象（不直接写教训，由主线程按序写）。"""
        t0 = time.time()
        try:
            transcript = run_case(case, lessons_block)
            verdict = judge_case(case, transcript)
        except Exception as e:  # noqa: BLE001
            return {"id": case["id"], "category": case["category"],
                    "error": f"{type(e).__name__}: {str(e)[:200]}"}
        return {
            "id": case["id"], "category": case["category"], "title": case["title"],
            "pass": verdict["pass"], "scores": verdict["scores"],
            "details": verdict["details"], "lesson": verdict["lesson"],
            "transcript": transcript, "seconds": round(time.time() - t0, 1),
        }

    # 用例之间完全独立（各自 eval-<id> 记忆空间），小并发回放；报告按原用例顺序
    max_workers = min(2, len(cases))
    results = [None] * len(cases)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(run_one, case): i for i, case in enumerate(cases)}
        done_count = 0
        for fut in concurrent.futures.as_completed(futures):
            idx = futures[fut]
            case = cases[idx]
            result = fut.result()
            results[idx] = result
            done_count += 1
            if result.get("error"):
                print(f"\n=== [{done_count}/{len(cases)}] {case['id']} ===\n  执行失败: {result['error']}", flush=True)
                continue
            mark = "PASS" if result["pass"] else "FAIL"
            print(f"\n=== [{done_count}/{len(cases)}] {case['id']} | {case['title']} ===", flush=True)
            print(f"  [{mark}] {'/'.join(map(str, result['scores']))} ({result['seconds']}s)", flush=True)
            for d in result["details"]:
                print(f"    - ({d['score']}) {d['reason'][:80]}", flush=True)
            if not result["pass"] and result["lesson"] and not args.no_lessons:
                append_lesson(cases[idx], result["lesson"])
                print(f"  [lesson] {result['lesson'][:80]}", flush=True)

    passed = sum(1 for r in results if r.get("pass"))
    errored = sum(1 for r in results if r.get("error"))
    print(f"\n===== 总计 {len(results)} 条：通过 {passed}，失败 {len(results) - passed - errored}，错误 {errored} =====")

    os.makedirs(REPORTS_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    report_path = os.path.join(REPORTS_DIR, f"report-{ts}.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump({"ts": ts, "results": results,
                   "summary": {"total": len(results), "passed": passed}}, f,
                  ensure_ascii=False, indent=2)
    print(f"[report] {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
