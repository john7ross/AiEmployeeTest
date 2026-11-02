# -*- coding: utf-8 -*-
"""Свободные ответы («свой вариант») и оценки опор.

Приложение опроса намеренно не даёт «своему варианту» веса (js/survey.js: «свой вариант не получает
выдуманный вес»), поэтому у человека с несколькими свободными ответами характеристика может не набрать
минимум ответов (лист Settings ▸ min_answers) и остаться пустой, а с ней и портрет.

Что делает модуль:
  * diagnose()  — для каждой характеристики: сколько ответов с весом, сколько нужно, какие ответы свободные;
  * apply()     — если рядом лежит файл разбора свободных ответов (own_answers_map.json, config.json →
                  own_answers_map), досчитывает пустые характеристики, считая такой ответ как ближайший вариант.
                  Соответствие выбирает человек (или модель по просьбе человека) и записывает с причиной;
                  инструмент сам смысл текста не угадывает. Оценка помечается «по разбору свободных ответов»
                  и в таблицу опроса не пишется.

Веса — в portrait_weights.json; берутся из js/config.js приложения командой
  python own_answers.py --sync [путь/к/js/config.js]     (нужен node)
"""
import os, re, json, subprocess, sys, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
WEIGHTS = os.path.join(HERE, "portrait_weights.json")
DIMS = ("adoption", "interest", "safety")
DIM_RU = {"adoption": "принятие", "interest": "интерес", "safety": "безопасность"}


def default_config_js():
    """js/config.js приложения: config.json → app_config_js, иначе рядом в репозитории (skill/ai-survey-pulse/tools → ../../../js)."""
    try:
        cfg = json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8-sig")).get("app_config_js")
    except (OSError, ValueError):
        cfg = None
    for cand in (cfg, os.path.join(HERE, "..", "..", "..", "js", "config.js")):
        if cand and os.path.exists(cand):
            return os.path.normpath(cand)
    raise SystemExit("js/config.js не найден: укажите путь (--sync ПУТЬ) или app_config_js в config.json")


def load_weights():
    try:
        return json.load(open(WEIGHTS, encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def sync(config_js):
    """Достаёт portrait из js/config.js приложения (window.CONFIG) и кладёт в portrait_weights.json."""
    js = ("const vm=require('vm'),fs=require('fs');const ctx={window:{}};vm.createContext(ctx);"
          "vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),ctx);"
          "const P=ctx.window.CONFIG.portrait;"
          "console.log(JSON.stringify({scores:P.scores,weights:Object.fromEntries(Object.entries(P.dimensions).map(([k,v])=>[k,v.weight])),thresholds:P.thresholds}));")
    out = subprocess.run(["node", "-e", js, config_js], capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise SystemExit("node не отработал: " + out.stderr[:300])
    data = json.loads(out.stdout)
    data["source"] = "js/config.js приложения"
    json.dump(data, open(WEIGHTS, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"веса: {len(data['scores'])} вопросов -> {WEIGHTS}")


def load_map(path, wave):
    """{ 'id': { 'qid': {'as': 'A', 'why': '...'} } } для волны; пусто, если файла нет."""
    if not path or not os.path.exists(path):
        return {}
    try:
        return (json.load(open(path, encoding="utf-8-sig")).get(f"wave{wave}") or {})
    except ValueError:
        return {}


def _vals(weights, resp, asked_set, dim, extra=None):
    """Баллы характеристики: (qid, балл, 'выбран'|'по разбору'), свободные ответы без соответствия — отдельно."""
    got, free = [], []
    for q, w in weights["scores"].items():
        if q not in asked_set:
            continue
        has = [L for L, d in w.items() if dim in d]
        if not has:
            continue
        ans = str(resp.get(q, "")).strip()
        if ans in w and dim in w[ans]:
            got.append((q, w[ans][dim], "выбран"))
        elif ans and ans != "TIMEOUT":
            m = (extra or {}).get(q)
            if m and m.get("as") in w and dim in w[m["as"]]:
                got.append((q, w[m["as"]][dim], "по разбору"))
            else:
                free.append(q)
    return got, free


def diagnose(resp, asked_set, mins, weights=None):
    """По каждой характеристике: ответов с весом / нужно / свободные ответы."""
    weights = weights or load_weights()
    if not weights:
        return {}
    out = {}
    for dim in DIMS:
        got, free = _vals(weights, resp, asked_set, dim)
        out[dim] = {"scored": len(got), "need": mins.get(dim, 0), "free": free}
    return out


def apply(person, resp, asked_set, mins, wave, own_map, weights=None):
    """Досчитывает пустые характеристики по разбору свободных ответов. Возвращает True, если что-то досчитано."""
    weights = weights or load_weights()
    extra = (own_map or {}).get(str(person["id"]))
    if not weights or not extra:
        return False
    s = person["scores"]
    done = {}
    for dim in DIMS:
        if s.get(dim) is not None:
            continue
        got, _ = _vals(weights, resp, asked_set, dim, extra)
        if len(got) >= mins.get(dim, 0) and got:
            s[dim] = round(sum(v for _, v, _ in got) / len(got))
            done[dim] = {"score": s[dim], "n": len(got), "mapped": [q for q, _, how in got if how == "по разбору"]}
    if not done:
        return False
    # итог и ярлык — как в приложении: взвешенное среднее по тем характеристикам, что посчитаны
    tot = sum(s[d] * weights["weights"][d] for d in DIMS if s.get(d) is not None)
    wsum = sum(weights["weights"][d] for d in DIMS if s.get(d) is not None)
    if all(s.get(d) is not None for d in DIMS) and wsum > 0:
        s["avg"] = round(tot / wsum)
        person["portrait"] = next((t["label"] for t in weights["thresholds"] if s["avg"] <= t["max"]), "")
    person["scores_override"] = {"dims": done, "why": {q: v.get("why", "") for q, v in extra.items()},
                                 "confirmed": all(v.get("confirmed") for v in extra.values())}
    return True


def gs_block(analysis_json):
    """Список MANUAL_SCORES для backend/Code.gs (applyManualScores) по людям с досчитанной оценкой.
    В него попадают только характеристики, досчитанные по разбору; подтверждённые человеком."""
    data = json.load(open(analysis_json, encoding="utf-8-sig"))
    out = []
    for p in data.get("people", []):
        ov = p.get("scores_override")
        if not ov:
            continue
        if not ov.get("confirmed"):
            print(f"// #{p['id']} {p['name']}: соответствия не подтверждены (confirmed) — в список не включён", file=sys.stderr)
            continue
        parts = [f"id: {p['id']}", f"wave: {data.get('wave')}"] + [f"{d}: {v['score']}" for d, v in ov["dims"].items()]
        qs = sorted({q for v in ov["dims"].values() for q in v["mapped"]})
        why = f"Свободные ответы {', '.join(qs)} приравнены к ближайшему варианту (разбор подтверждён человеком)"
        out.append("  { " + ", ".join(parts) + ",\n    why: '" + why + "' }")
    return "var MANUAL_SCORES = [\n" + ",\n".join(out) + "\n];"


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sync", nargs="?", const="")
    ap.add_argument("--gs", metavar="analysis.json", help="напечатать MANUAL_SCORES для Code.gs")
    a = ap.parse_args()
    if a.sync is not None:
        sync(a.sync or default_config_js())
    elif a.gs:
        print(gs_block(a.gs))
    else:
        ap.print_help()
