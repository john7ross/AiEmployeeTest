# -*- coding: utf-8 -*-
"""Ретро-дашборд по любому числу волн опроса: HTML одним файлом, только агрегаты, без имён.

Usage:
  python retro.py --out DIR --fetch [--waves 1 2 3] [--since 2026-07-06]
                  [--metrics-xlsx FILE | --fetch-metrics]
                  [--extra-xlsx FILE ...] [--story story.json] [--no-repo]

Что считается (всё из сырых листов, не из прошлых отчётов):
  * состав: «нынешний отдел» = Usages «Участвует? = Да»; руководитель (config → lead_ids) и
    тестовые профили в метрики не входят; ушедшие из отдела в сравнения не входят;
  * по каждой волне: кто прошёл, знания (процент верных от личного набора, таймаут = неверно),
    по вопросам знаний, распределения ответов на остальные вопросы, три опоры и портреты (из
    среза волны в history_dir), доля «регулярно используют» (вопрос 511);
  * сквозные: те, кто прошёл подряд две волны (рост / падение знаний), вовлечённость (Usages);
  * репозиторий ai-tools (папка отдела, origin/main) по неделям: инструменты, файлы, авторы;
  * таблица метрик отдела (лист отдела): ряды по датам, цели, мероприятия;
  * необязательно: книги «Обмены опытом» и «Внедрение ИИ» (голосование за темы) — --extra-xlsx.

Текст выводов пишет человек или модель в story.json (необязательный файл):
  {"title": "...", "subtitle": "...", "lead": "...", "findings": [{"title": "...", "text": "...", "tone": "ok|warn|info"}],
   "notes": ["строка под шапкой", ...]}
Цифры в тексты руками не переписывать: они берутся из данных. Без story.json выводов нет, только цифры.
"""
import os, re, json, argparse, datetime as dt, glob, collections, statistics as st
import survey_lib as L
import ba_repo as B
import analyze as A

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "..", "reference", "retro_template.html")


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return round(st.mean(xs), 1) if xs else None


# --------------------------------------------------------------------------
# Состав и ответы
# --------------------------------------------------------------------------
def team_ids(data):
    """Нынешний отдел: Usages «Участвует? = Да»."""
    out = set()
    for eid, row in data.get("usages", {}).items():
        if str(row.get("Участвует?", "")).strip().lower() == "да":
            out.add(int(eid))
    return out


def knowledge_ids(data, wave):
    seen = set()
    for resp in data["responses_by_wave"].get(wave, {}).values():
        seen |= set(resp)
    return sorted((q for q in seen if (data["answers"].get(q) or {}).get("correct")), key=int)


def person_knowledge(resp, ids, answers):
    """Процент верных или None, если человек ответил не на весь блок."""
    if not ids or any(q not in resp for q in ids):
        return None
    ok = sum(1 for q in ids if resp[q] == answers[q]["correct"])
    return ok / len(ids) * 100


def load_snapshots():
    hist = L.CFG.get("history_dir")
    snaps = {}
    for f in sorted(glob.glob(os.path.join(hist, "wave_*.json"))) if hist else []:
        try:
            s = json.load(open(f, encoding="utf-8-sig"))
        except (OSError, ValueError):
            continue
        w = s.get("wave")
        if isinstance(w, int) and (w not in snaps or str(s.get("wave_date", "")) >= str(snaps[w].get("wave_date", ""))):
            snaps[w] = s
    return snaps


def wave_block(data, wave, team, lead_ids, snaps):
    resp = data["responses_by_wave"].get(wave, {})
    ans, qs = data["answers"], data["questions"]
    kn_ids = knowledge_ids(data, wave)
    passed = {int(e) for e, r in resp.items() if r and e.isdigit() and int(e) not in set(L.CFG.get("test_employee_ids", []))}
    passed = {e for e in passed if resp[str(e)]}
    t_pass = sorted(passed & team)
    block = {"n": wave, "passed_team": len(t_pass), "passed_lead": bool(passed & lead_ids),
             "passed_all": len(passed), "ids_team": t_pass}
    # знания
    per_person = {e: person_knowledge(resp[str(e)], kn_ids, ans) for e in t_pass} if kn_ids else {}
    vals = [v for v in per_person.values() if v is not None]
    perq = []
    for q in kn_ids:
        got = [resp[str(e)].get(q) for e in t_pass if q in resp[str(e)]]
        ok = sum(1 for x in got if x == ans[q]["correct"])
        perq.append({"id": q, "text": (qs.get(q) or {}).get("text", ""), "n": len(got), "pct": round(ok / len(got) * 100) if got else None,
                     "timeout": sum(1 for x in got if str(x).upper() == "TIMEOUT")})
    block["knowledge"] = {"questions": len(kn_ids), "mean": _mean(vals), "dist": sorted(round(v) for v in vals),
                          "per_q": perq, "timeouts": sum(q["timeout"] for q in perq),
                          "answers": len(t_pass) * len(kn_ids)} if kn_ids else None
    block["_per_person"] = per_person
    # остальные вопросы: распределение ответов отдела
    soft = {}
    qids = []
    for r in resp.values():
        for q in r:
            if q not in qids:
                qids.append(q)
    for q in sorted(qids, key=int):
        if (ans.get(q) or {}).get("correct"):
            continue
        cnt = collections.Counter()
        for e in t_pass:
            v = resp[str(e)].get(q)
            if v in (None, ""):
                continue
            cnt[v if v in ("A", "B", "C", "D") else "own"] += 1
        if cnt:
            a = ans.get(q) or {}
            soft[q] = {"text": (qs.get(q) or {}).get("text", ""), "n": sum(cnt.values()), "counts": dict(cnt),
                       "opts": {k: str(a[k]) for k in "ABCD" if a.get(k)}}
    block["soft"] = soft
    # регулярность (511)
    if "511" in soft:
        c = soft["511"]["counts"]
        block["regular"] = {"yes": c.get("D", 0), "n": soft["511"]["n"]}
    # три опоры и портреты — из среза волны, без руководителя и не из отдела
    snap = snaps.get(wave)
    if snap:
        people = [p for p in snap.get("people", []) if p["id"] in team and p["id"] not in lead_ids]
        scored = [p for p in people if p["scores"].get("avg") is not None]
        if scored:
            block["dims"] = {"n": len(scored), "adoption": _mean([p["scores"].get("adoption") for p in scored]),
                             "interest": _mean([p["scores"].get("interest") for p in scored]),
                             "safety": _mean([p["scores"].get("safety") for p in scored]),
                             "avg": _mean([p["scores"].get("avg") for p in scored]),
                             "portrait": dict(collections.Counter(p.get("portrait") or "без портрета" for p in scored)),
                             "calibration": _mean([p["scores"].get("calibration") for p in scored])}
    return block


def lead_block(data, waves, lead, snaps):
    """Руководитель проходит опрос по желанию: в метрики отдела не входит, описывается отдельно.
    По каждой волне: прошла ли, знания, опоры и портрет из среза, выбранные ответы."""
    ans, qs = data["answers"], data["questions"]
    out = []
    for w in waves:
        resp = data["responses_by_wave"].get(w, {})
        for lid in sorted(lead):
            r = resp.get(str(lid))
            if not r:
                continue
            kn_ids = knowledge_ids(data, w)
            kp = person_knowledge(r, kn_ids, ans)
            snap_p = next((p for p in (snaps.get(w) or {}).get("people", []) if p["id"] == lid), None)
            sc = (snap_p or {}).get("scores") or {}
            picks = []
            for q, v in r.items():
                if (ans.get(q) or {}).get("correct") or v in ("", None):
                    continue
                a = ans.get(q) or {}
                choice = str(a.get(v)) if v in ("A", "B", "C", "D") and a.get(v) else "свой ответ: " + str(v)
                picks.append({"q": q, "text": (qs.get(q) or {}).get("text", ""), "choice": choice[:200]})
            picks.sort(key=lambda x: int(x["q"]))
            out.append({"wave": w, "knowledge": None if kp is None else round(kp),
                        "timeouts": sum(1 for q in kn_ids if str(r.get(q, "")).upper() == "TIMEOUT"),
                        "dims": {k: sc.get(k) for k in ("adoption", "interest", "safety", "avg", "calibration")} if sc.get("avg") is not None else None,
                        "portrait": (snap_p or {}).get("portrait") or None, "picks": picks})
    return out


def matched(blocks):
    out = []
    for a, b in zip(blocks, blocks[1:]):
        pa, pb = a["_per_person"], b["_per_person"]
        ids = [e for e in pa if pa[e] is not None and pb.get(e) is not None]
        if not ids:
            continue
        d = [pb[e] - pa[e] for e in ids]
        out.append({"from": a["n"], "to": b["n"], "n": len(ids), "mean_from": round(st.mean(pa[e] for e in ids), 1),
                    "mean_to": round(st.mean(pb[e] for e in ids), 1),
                    "up": sum(1 for x in d if x > 3), "down": sum(1 for x in d if x < -3), "same": sum(1 for x in d if abs(x) <= 3)})
    return out


# --------------------------------------------------------------------------
# Репозиторий ai-tools по неделям
# --------------------------------------------------------------------------
def repo_series(dept_names, since):
    repo, folder, branch = B.settings()
    if not os.path.isdir(os.path.join(repo, ".git")):
        return {"error": f"нет клона {repo} (config → ai_tools_repo)"}
    B.fetch(repo)
    head = B.revision(repo, branch, None)
    keys = {B.norm_name(n): n for n in dept_names}
    rows = []
    for f in B.files(repo, head, folder):
        if not f.endswith("/index.md"):
            continue
        text = B._git(repo, "show", f"{head}:{f}").stdout
        i_author = None
        for line in text.splitlines():
            if not line.startswith("|"):
                if not line.strip():
                    i_author = None
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if any("Автор" in c for c in cells):
                i_author = next(i for i, c in enumerate(cells) if "Автор" in c)
                continue
            if i_author is None or set("".join(cells)) <= set("-: "):
                continue
            names = [n.strip() for n in re.split(r"[,;]", cells[i_author]) if n.strip() and n.strip() not in ("—", "-")]
            if names:
                rows.append((line.lower(), names))

    def authors_of(unit):
        kind, name = unit
        key = name.split("/")[-1].lower()
        stem = re.sub(r"\.(md|pdf|docx|html|pptx|zip)$", "", key)
        found = []
        for line, names in rows:
            if kind in ("скилл", "скрипт"):
                hit = f"| {key} |" in line or f"/{key}/" in line or f"/{key})" in line or f"({key}" in line
            else:
                hit = key in line or (len(stem) > 6 and stem in line)
            if hit:
                found += names
        return found

    def snap(asof):
        rev = B.revision(repo, branch, asof)
        if not rev:
            return None
        us = B.units(repo, rev, folder)
        dept_auth = set()
        for u in us:
            for n in authors_of(u):
                if B.norm_name(n) in keys:
                    dept_auth.add(keys[B.norm_name(n)])
        return {"units": len(us), "files": len(B.files(repo, rev, folder)), "dept_authors": len(dept_auth),
                "by_kind": dict(collections.Counter(k for k, _ in us))}

    d = since - dt.timedelta(days=since.weekday())
    series, today = [], dt.date.today()
    while d <= today:
        s = snap(d)
        if s and s["units"]:
            s["date"] = d.isoformat()
            series.append(s)
        d += dt.timedelta(days=7)
    now = snap(None)
    now["date"] = today.isoformat()
    if not series or series[-1]["date"] != now["date"]:
        series.append(now)
    return {"folder": folder, "series": series, "now": now}


# --------------------------------------------------------------------------
# Таблица метрик, обмены опытом, голосование
# --------------------------------------------------------------------------
def metrics_block(xlsx):
    m = L.parse_metrics(xlsx, None)
    if not m.get("sheet"):
        return None
    series = []
    for key, block in m["blocks"].items():
        if not key.startswith("Метрики."):
            continue
        kind = "pct" if "Опрос" in key else "cnt"
        for row in block["rows"]:
            vals = [(d, v) for d, v in row["values"].items() if isinstance(v, (int, float))]
            if vals:
                series.append({"name": row["name"].strip(), "kind": kind, "dates": [d for d, _ in vals], "v": [v for _, v in vals],
                               "target": row["target"] if isinstance(row["target"], (int, float)) else None})
    return {"sheet": m["sheet"], "series": series, "events": m["events"], "dept_size": m.get("dept_size")}


def add_metrics_column(metrics, csv_path, date):
    """Дописывает в ряды таблицы метрик расчётный столбец (CSV из metrics_column.py).
    Пустые значения и строки, чья единица не сходится с рядом (часы против долей), пропускаются с сообщением."""
    import csv
    if not metrics:
        return
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        rows = {r["Метрика"].strip(): r for r in csv.DictReader(f, delimiter=";")}
    for s in metrics["series"]:
        r = rows.get(s["name"])
        raw = (r or {}).get(date, "").strip() if r else ""
        if not raw:
            continue
        v = float(raw.replace(",", "."))
        if s["kind"] == "pct" and (s.get("target") or 1) <= 1 and v > 1:
            print(f"пропущено в рядах: «{s['name']}» = {v} — единица не сходится с рядом (доли), решить отдельно")
            continue
        s["dates"].append(date)
        s["v"].append(v)


def _norm(t):
    import re
    return re.sub(r"[^0-9a-zа-яё]+", " ", str(t).lower().replace("ё", "е")).strip()


def link_votes_to_meetings(payload, vote_map):
    """К каждой теме голосования — встреча из таблицы метрик («Мероприятия»), если такая есть.

    Источник встреч — таблица метрик (её ведёт владелец, там «перенесли с …»), а не лист «Обмены опытом»:
    даты в листе расходятся с таблицей. Совпадение — по названию без регистра и знаков; остальное только
    через vote_map из story.json ({тема голосования: название встречи в таблице}), потому что называться
    встреча может иначе («Риски и ответственность» → «Безопасность при работе с ИИ»)."""
    votes, m = payload.get("votes"), payload.get("metrics")
    if not votes or not m or not m.get("events"):
        return
    by_name = {_norm(e["name"]): e for e in m["events"]}
    for t in votes["topics"]:
        target = (vote_map or {}).get(t["topic"], t["topic"])
        e = by_name.get(_norm(target))
        if e:
            t["meeting"] = {"name": e["name"], "date": e["date"], "status": e["status"]}
    top = votes["topics"][:10]
    print("голосование → встречи (топ-10):")
    for t in top:
        me = t.get("meeting")
        print(f"  {t['topic']}: " + (f"{me['date']} · {me['status']} · {me['name']}" if me else "встречи в таблице метрик не нашёл — проверить вручную"))


def extra_books(paths, dept_names):
    import openpyxl
    out = {}
    surnames = {n.split()[0] for n in dept_names}
    for p in paths:
        wb = openpyxl.load_workbook(p, data_only=True)
        if "Обмены опытом" in wb.sheetnames:
            held, planned = [], []
            for r in wb["Обмены опытом"].iter_rows(min_row=2, values_only=True):
                d, topic, leaders = r[0], r[1], r[2]
                if not isinstance(d, dt.datetime) or not topic or d < dt.datetime(2026, 7, 16):
                    continue
                if any(w in str(topic).lower() for w in ("перенос", "отмена")):
                    continue
                ls = sorted(s for s in surnames if leaders and s in str(leaders))
                (planned if d > dt.datetime.today() else held).append({"date": d.strftime("%Y-%m-%d"), "topic": str(topic).strip(), "leaders": len(ls), "ls": ls})
            out["exch"] = {"held": len(held), "planned": len(planned), "leaders_held": len({x for m in held for x in m["ls"]}),
                           "leaders_all": len({x for m in held + planned for x in m["ls"]}),
                           "held_topics": [{k: m[k] for k in ("date", "topic")} for m in held],
                           "planned_topics": [{k: m[k] for k in ("date", "topic")} for m in planned]}
        if "Внедрение ИИ" in wb.sheetnames:
            vr = list(wb["Внедрение ИИ"].iter_rows(values_only=True))
            hdr = vr[2]
            voters = [hdr[c] for c in range(1, 16) if hdr[c] and any(vr[r][c] not in (None, "") for r in range(3, len(vr)))]
            topics = [{"topic": r[16], "score": r[17], "fires": r[18], "rank": r[22]} for r in vr[3:] if r[16] and r[17] is not None]
            topics.sort(key=lambda t: -t["score"])
            out["votes"] = {"voters_dept": len([v for v in voters if v in dept_names]), "team": len(dept_names), "topics": topics}
    return out


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--xlsx")
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--waves", type=int, nargs="*")
    ap.add_argument("--since", help="начало ряда по репозиторию, ГГГГ-ММ-ДД (по умолчанию — 8 недель до первой волны)")
    ap.add_argument("--metrics-xlsx")
    ap.add_argument("--fetch-metrics", action="store_true")
    ap.add_argument("--metrics-column", help="CSV из metrics_column.py: расчётный столбец дописывается в ряды метрик")
    ap.add_argument("--metrics-column-date", default=None, help="дата столбца, как в заголовке CSV (по умолчанию — вторая колонка CSV)")
    ap.add_argument("--extra-xlsx", nargs="*", default=[])
    ap.add_argument("--story")
    ap.add_argument("--no-repo", action="store_true")
    ap.add_argument("--exclude-lead", action="store_true", help="не считать руководителя (по умолчанию она считается вместе с остальными)")
    ap.add_argument("--lead-block", action="store_true", help="отдельный блок «Наш руководитель» (по умолчанию нет: показатели не персонифицируются)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    xlsx = a.xlsx
    if a.fetch or not xlsx:
        xlsx = os.path.join(a.out, "live_sheet.xlsx")
        L.fetch_sheet(xlsx)
    data = L.parse(xlsx)
    dept, lead = team_ids(data), set(L.CFG.get("lead_ids", []))
    names = [str(r.get("ФИО", "")).strip() for e, r in data["usages"].items() if int(e) in dept]
    # Решение владельца 23.10.2026: в дашборде руководитель считается вместе с остальными, без персонализации.
    team = dept if a.exclude_lead else (dept | lead)
    lead_x = lead if a.exclude_lead else set()      # кого вычитать из расчёта
    waves = a.waves or data["waves"]
    snaps = load_snapshots()
    blocks = [wave_block(data, w, team, lead_x, snaps) for w in waves]
    comp = {"team_size": len(team), "dept_size": len(dept), "usage_size": len(dept), "lead_counted": not a.exclude_lead, "waves": waves}

    usage_cols = ["Агент", "Подключил ai-tools", "Выложил артефакт", "Мероприятия", "Использует инструмент"]
    usages = {c: sum(1 for e, r in data["usages"].items() if int(e) in dept and str(r.get(c, "")).strip().lower() == "да") for c in usage_cols}
    undefined = {c: sum(1 for e, r in data["usages"].items() if int(e) in dept and str(r.get(c, "")).strip().lower() == "не определено") for c in usage_cols}

    # даты опросов — по Employees_history/срезам
    spans = {}
    for w, s in snaps.items():
        if w in waves:
            spans[str(w)] = s.get("wave_date")

    metrics = None
    mx = a.metrics_xlsx
    if a.fetch_metrics or (not mx and L.CFG.get("metrics_sheet_id")):
        mx = os.path.join(a.out, "metrics_sheet.xlsx")
        L.fetch_metrics(mx)
    if mx:
        metrics = metrics_block(mx)
    if a.metrics_column and metrics:
        d = a.metrics_column_date or open(a.metrics_column, encoding="utf-8-sig").readline().split(";")[1].strip()
        add_metrics_column(metrics, a.metrics_column, d)

    repo = None
    if not a.no_repo:
        first = min((s["wave_date"] for s in snaps.values() if s.get("wave_date")), default=dt.date.today().isoformat())
        since = dt.date.fromisoformat(a.since) if a.since else dt.date.fromisoformat(first) - dt.timedelta(days=56)
        repo = repo_series(names, since)

    extra = extra_books(a.extra_xlsx, names) if a.extra_xlsx else {}
    story = json.load(open(a.story, encoding="utf-8-sig")) if a.story else {}
    lead_rows = lead_block(data, waves, lead, snaps) if a.lead_block else []

    pairs = matched(blocks)
    for b in blocks:
        b.pop("_per_person", None)
        b.pop("ids_team", None)
    payload = {"built": dt.date.today().strftime("%d.%m.%Y"), "comp": comp, "waves": blocks, "matched": pairs,
        "lead": lead_rows, "usages": usages, "undefined": undefined, "spans": spans, "metrics": metrics, "repo": repo, "story": story, **extra}
    link_votes_to_meetings(payload, story.get("vote_map"))
    json.dump(payload, open(os.path.join(a.out, "retro_data.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    html = open(TEMPLATE, encoding="utf-8").read().replace("/*__DATA__*/null", json.dumps(payload, ensure_ascii=False, default=str))
    dest = os.path.join(a.out, "retro_dashboard.html")
    open(dest, "w", encoding="utf-8").write(html)
    print("волны:", waves, "| отдел", len(team), "| прошли по волнам:", [b["passed_team"] for b in blocks])
    print("знания по волнам, %:", [b["knowledge"]["mean"] if b["knowledge"] else None for b in blocks])
    print("сквозные пары:", payload["matched"])
    print("репозиторий:", (repo or {}).get("now"))
    print("->", dest)


if __name__ == "__main__":
    main()
