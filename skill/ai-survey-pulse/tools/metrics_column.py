# -*- coding: utf-8 -*-
"""Посчитать столбец для таблицы метрик по итогам волны опроса.

Скилл читает таблицу метрик, но НЕ пишет в неё: чтение идёт по export-ссылке
без авторизации, для записи нужен OAuth. Поэтому инструмент считает значения и
печатает их в порядке строк листа отдела — остаётся вставить столбец руками.

Usage:
  python metrics_column.py --analysis DIR/analysis.json [--date 01.09.2026]
                           [--metrics-xlsx FILE] [--dept БА] [--csv FILE]

Что делает:
  1. считает метрики опроса по analysis.json;
  2. сверяет с тем, что уже записано в таблице (последний заполненный столбец);
  3. показывает мероприятия: что просрочено и что впереди;
  4. проверяет антиметрики, которые считаются автоматически.
"""
import os, json, glob, argparse, csv, datetime
import survey_lib as L
import ba_repo as R
from analyze import TIME_SAVING_HOURS

# Определения строк утверждены владельцем 15.09.2026 — reference/metrics.md,
# раздел «Таблица метрик отдела». Общие правила:
#   * доли — от численности отдела (лист Usages, «Участвует? ≠ Нет»; сверяется
#     с «Количество сотрудников в отделе» в таблице);
#   * в ai-tools смотрится только папка отдела (config → ai_tools_folder);
#   * вопрос, которого в волне не было, — пусто, а не 0.
# Каждая функция получает контекст ctx и возвращает (значение, пояснение).


def _share(part, whole):
    return round(part / whole, 2) if whole else None


def _in_dept(ctx, people):
    return [p for p in people if p["id"] in ctx["dept_ids"]]


def _regular(ctx):
    asked = [p for p in _in_dept(ctx, ctx["people"]) if p["prefs"].get("511", "не задавался") != "не задавался"]
    if asked:
        yes = [p for p in asked if L.is_regular_user(p["prefs"]["511"])]
        return _share(len(yes), len(asked)), f"вопрос 511, от прошедших волну из отдела ({len(yes)} из {len(asked)})"
    prev = ctx.get("regular_prev")
    tail = f"; в волне {prev['wave']} было {prev['value']} ({prev['detail']})" if prev else ""
    return None, "вопрос 511 в этой волне не задавали — добавить в каждую волну" + tail


def _enthusiasts(ctx):
    src = ctx.get("portrait_wave")
    if not src:
        return None, "ни в одной волне нет портретов"
    enth = {i for i, lab in src["portraits"].items() if lab == "Энтузиаст"} & ctx["dept_ids"]
    both = enth & ctx["active_ids"]
    return _share(len(both), ctx["dept_size"]), \
        (f"портрет «Энтузиаст» (волна {src['wave']}: {len(enth)}) И активное участие — "
         f"{len(both)} из {ctx['dept_size']}")


def _engaged(ctx):
    n = len(ctx["active_ids"])
    return _share(n, ctx["dept_size"]), f"активное участие — {n} из {ctx['dept_size']} ({ctx['active_how']})"


def _knowledge(ctx):
    v = ctx["agg"].get("knowledge_pct_mean")
    if v is None:
        return None, "в волне нет знаниевого блока"
    return round(v / 100, 2), f"среднее по людям от личного набора, таймаут = неверно ({ctx['agg']['n']} чел.)"


def _awareness(ctx):
    a = ctx["agg"]
    counted = a.get("data_awareness_counted") or 0
    if counted:
        full = len(a.get("data_awareness_full") or [])
        return _share(full, counted), \
            (f"все ответы блока безопасности верны — {full} из {counted}; "
             f"происшествия ИБ — уточнить у ИБ (есть — метрика 0)")
    asked = a["n"] - a["data_care"].get("не задавался", 0)
    if asked:
        return _share(a["data_care"]["обезличил бы (B)"], asked), \
            f"ДРУГОЙ СПОСОБ: блока безопасности нет, вопрос 411 «сначала обезличу» ({asked} чел.)"
    return None, "в волне нет ни блока безопасности, ни вопроса 411"


def _usage(signal):
    def fn(ctx):
        d = ctx["usage_dept"]
        undef = d["undefined"].get(signal, 0)
        return d["counts"].get(signal), \
            f"лист Usages, «{signal}» = Да" + (f"; не определено у {undef} — уточнить опросом" if undef else "")
    return fn


def _uploaded(ctx):
    if not ctx["repo_ok"]:
        return None, f"репозиторий недоступен: {ctx['repo_error']}"
    names = sorted(ctx["dept_authors"].values())
    usages = ctx["usage_dept"]["counts"].get("Выложил артефакт")
    return len(names), (f"авторы из index.md папки {ctx['folder']}, только отдел: {', '.join(names)}"
                        + (f" (Usages: {usages})" if usages != len(names) else ""))


def _artifacts(ctx):
    if not ctx["repo_ok"]:
        return None, f"репозиторий недоступен: {ctx['repo_error']}"
    kinds = {}
    for k, _ in ctx["units"]:
        kinds[k] = kinds.get(k, 0) + 1
    return len(ctx["units"]), (f"инструменты в {ctx['folder']} на {ctx['repo_asof']}: "
                               + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())))


def _dept_answers(ctx, qid):
    """[(человек, буква)] отдела, кому вопрос qid задавали и кто на него ответил буквой."""
    out = []
    for p in _in_dept(ctx, ctx["people"]):
        v = (p.get("raw") or {}).get(qid, "")
        if v in ("A", "B", "C", "D"):
            out.append((p, v))
    return out


def _time_saving(ctx):
    """Вопрос 131: доля рабочей недели, которую ИИ экономит (в таблице строка в долях, цель 0,5).

    Час в неделю по серединам интервалов (0 / 0,5 / 2 / 4 ч) делится на рабочую неделю
    (config.json -> work_week_hours, по умолчанию 40) и усредняется по отделу.
    «Больше 3» взято как 4 ч — ориентир, не замер; неделя 40 ч — допущение (решение владельца 02.11.2026:
    считать долями, как в таблице)."""
    got = _dept_answers(ctx, "131")
    if not got:
        return None, "вопрос 131 в этой волне не задавали — добавить в волну (закрытая шкала: 0 / до 1 / 1–3 / больше 3 ч)"
    week = float(L.CFG.get("work_week_hours", 40))
    hours = [TIME_SAVING_HOURS[v] for _, v in got]
    mean_h = sum(hours) / len(hours)
    share = round(mean_h / week, 2)
    saving = len([1 for _, v in got if v in ("C", "D")])
    return share, (f"ДОЛЯ рабочей недели ({week:g} ч): в среднем {mean_h:.1f} ч в неделю, вопрос 131 "
                   f"({len(got)} из {ctx['dept_size']} чел. отдела); экономят от часа и больше: {saving} из {len(got)}; "
                   f"«больше 3» взято как 4 ч — ориентир, не замер")


def _from_134(usage_signal, letters, label):
    """Строка про репозиторий: по вопросу 134, а если его в волне не было — по листу Usages."""
    def fn(ctx):
        got = _dept_answers(ctx, "134")
        if not got:
            val, note = _usage(usage_signal)(ctx)
            return val, note + " (вопроса 134 в волне не было)"
        yes = [p for p, v in got if v in letters]
        d = ctx["usage_dept"]
        silent = ctx["dept_size"] - len(got)
        return len(yes), (f"вопрос 134, {label}: {len(yes)} из {len(got)} ответивших; "
                          f"не ответили {silent} чел. (они в число не входят); Usages: {d['counts'].get(usage_signal)}")
    return fn


def _foreign_skills(ctx):
    """Вопрос 134 даёт число чужих инструментов у человека, а не их список: число РАЗНЫХ скиллов не восстановить."""
    got = _dept_answers(ctx, "134")
    if not got:
        return None, "вопрос в опросе «какими скиллами из ai-tools пользуетесь, без своих» — в волне не было"
    one_two = len([1 for _, v in got if v == "C"])
    three = len([1 for _, v in got if v == "D"])
    return None, (f"вопрос 134 даёт только число инструментов у человека: «1–2» — {one_two}, «3 и больше» — {three} чел.; "
                  f"в сумме не меньше {one_two + 3 * three}, но с повторами. Число РАЗНЫХ чужих скиллов нужно спрашивать списком")


def _manual(note):
    return lambda ctx: (None, note)


# (подстрока названия строки, функция). Порядок значения не имеет.
METRICS = [
    ("Доля регулярно использующих ИИ", _regular),
    ("Доля энтузиастов", _enthusiasts),
    ("Количество сотрудников, вовлеченных в развитие", _engaged),
    ("Процент верных ответов в опросе сотрудника", _knowledge),
    ("Осознанность при работе с чувствительными данными", _awareness),
    ("Субъективная экономия времени", _time_saving),
    ("Сотрудников с настроенным ИИ-агентом", _usage("Агент")),
    ("Сотрудников, подключивших общий репозиторий", _from_134("Подключил ai-tools", ("B", "C", "D"), "подключили: «подключён» или использовали")),
    ("Количество сотрудников, загрузивших артефакт в репозиторий", _uploaded),
    ("Количество артефактов в репозитории", _artifacts),
    ("Скиллов, использованных кем-то кроме автора", _foreign_skills),
    ("Количество сотрудников, использующих хотя бы один ии-инструмент", _from_134("Использует инструмент", ("C", "D"), "использовали чужие инструменты")),
    ("Количество ревью ТЗ, проведенных агентом",
     _manual("счётчик в инструменте ревью: одно ТЗ = одно ревью — инструмента пока нет")),
    ("Количество задач, имеющих артефакт БА",
     _manual("доля закрытых за месяц задач на анализ со страницей платформы:task:<номер> в docpo2 — вне скрипта")),
    ("Время, вложенное в обучение и репозиторий",
     _manual("трудозатраты по задачам с тегом внедрения ИИ + встречи обмена опытом — Битрикс, вне скрипта")),
]


def _snapshots():
    hist = L.CFG.get("history_dir")
    out = []
    for f in glob.glob(os.path.join(hist, "wave_*.json")) if hist else []:
        try:
            out.append(json.load(open(f, encoding="utf-8-sig")))
        except (OSError, ValueError):
            pass
    return out


def build_context(analysis, metrics, repo_asof=None, no_fetch=False):
    agg, people = analysis["aggregate"], analysis["people"]
    usage_dept = agg.get("usage_dept") or {"participants": 0, "members": [], "counts": {}, "undefined": {}}
    members = usage_dept.get("members") or []
    ctx = {"agg": agg, "people": people, "usage_dept": usage_dept,
           "dept_ids": {m["id"] for m in members}, "warnings": []}

    size_sheet = metrics.get("dept_size")
    ctx["dept_size"] = int(size_sheet) if str(size_sheet or "").isdigit() else len(members)
    if members and ctx["dept_size"] != len(members):
        ctx["warnings"].append(f"в таблице отдел {ctx['dept_size']} чел., на листе Usages {len(members)} — доли от таблицы")

    # Репозиторий: только папка отдела.
    repo, folder, branch = R.settings()
    ctx["folder"], ctx["repo_ok"], ctx["repo_error"] = folder, False, ""
    if not os.path.isdir(os.path.join(repo, ".git")):
        ctx["repo_error"] = f"нет клона {repo} (config → ai_tools_repo)"
    else:
        if not no_fetch:
            ok, err = R.fetch(repo)
            if not ok:
                ctx["warnings"].append(f"git fetch не прошёл ({err[:80]}) — считаю по последнему скачанному")
        rev = R.revision(repo, branch, repo_asof)
        if not rev:
            ctx["repo_error"] = f"в {branch} нет коммитов до {repo_asof}"
        else:
            ctx["repo_ok"] = True
            ctx["repo_asof"] = repo_asof.strftime("%d.%m.%Y") if repo_asof else "сегодня"
            ctx["units"] = R.units(repo, rev, folder)
            by_name = {R.norm_name(m["name"]): m["id"] for m in members}
            ctx["dept_authors"] = {}
            for tool, names in R.authors(repo, rev, folder).items():
                for n in names:
                    mid = by_name.get(R.norm_name(n))
                    if mid is not None:
                        ctx["dept_authors"][mid] = next(m["name"] for m in members if m["id"] == mid)

    # Активное участие: автор инструмента в папке отдела ИЛИ пользуется инструментом
    # из ai-tools. Одно посещение встреч не считается. Выступление на обмене опытом
    # видно через автора материала; выступил без материала — отметить на листе Usages
    # признаком «Выложил артефакт».
    active = set(ctx.get("dept_authors", {}))
    for m in members:
        u = m["usage"]
        if u.get("Использует инструмент", "").lower() == "да" or u.get("Выложил артефакт", "").lower() == "да":
            active.add(m["id"])
    ctx["active_ids"] = active
    ctx["active_how"] = "автор в репозитории или «Использует инструмент»/«Выложил артефакт» на Usages"

    # Портреты — из последней волны, где они считались (волна знаний их не даёт).
    cur_wave = analysis.get("wave", 1)
    waves = [s for s in _snapshots() if s.get("wave", 0) <= cur_wave] + [analysis]
    best = None
    for s in waves:
        portraits = {p["id"]: p["portrait"] for p in s.get("people", []) if p.get("portrait")}
        if portraits and (best is None or s.get("wave", 0) >= best["wave"]):
            best = {"wave": s.get("wave", 0), "portraits": portraits}
    ctx["portrait_wave"] = best

    # Регулярность из последней волны, где был 511, — только для справки.
    for s in sorted(waves, key=lambda s: -s.get("wave", 0)):
        asked = [p for p in s.get("people", []) if p["id"] in ctx["dept_ids"]
                 and p.get("prefs", {}).get("511", "не задавался") != "не задавался"]
        if asked and s is not analysis:
            yes = [p for p in asked if L.is_regular_user(p["prefs"]["511"])]
            ctx["regular_prev"] = {"wave": s.get("wave"), "value": _share(len(yes), len(asked)),
                                   "detail": f"{len(yes)} из {len(asked)}"}
            break
    return ctx


def _match(name, needle):
    return needle.lower() in " ".join(str(name).split()).lower()


def _manual_value(ctx, name):
    """Значения, которые скрипт посчитать не может (Битрикс, git-история задач): их считает агент и пишет в
    файл config.json -> metrics_manual: {"ДД.ММ.ГГГГ": {"название строки": {"value": 0.05, "source": "как считал"}}}.
    Берутся только на дату столбца и только если скрипт сам значения не дал."""
    path = L.CFG.get("metrics_manual")
    if not path or not os.path.exists(path):
        return None
    try:
        day = json.load(open(path, encoding="utf-8-sig")).get(ctx.get("date"), {})
    except ValueError:
        return None
    key = " ".join(str(name).split()).lower()
    for k, v in day.items():
        if " ".join(k.split()).lower() == key:
            return v
    return None


def last_recorded(row):
    """Последнее заполненное значение строки и дата этого столбца."""
    for date in reversed(list(row["values"])):
        return date, row["values"][date]
    return None, None


def compute(ctx, metrics):
    out = []
    for key, block in metrics["blocks"].items():
        if not key.startswith("Метрики."):
            continue
        kind = "опрос" if "Опрос" in key else "показатель"
        for row in block["rows"]:
            value, note = None, "строка не описана в скилле — считать вручную"
            for needle, fn in METRICS:
                if _match(row["name"], needle):
                    value, note = fn(ctx)
                    break
            if value is None:
                manual = _manual_value(ctx, row["name"])
                if manual:
                    value, note = manual["value"], "ВРУЧНУЮ ПО БИТРИКСУ (агент): " + manual["source"]
            date, recorded = last_recorded(row)
            out.append({"block": kind, "name": row["name"], "computed": value,
                        "recorded": recorded, "recorded_date": date,
                        "target": row["target"], "note": note})
    # Цель-численность больше отдела — недостижима по определению.
    for r in out:
        t = r["target"]
        if r["block"] == "показатель" and isinstance(t, (int, float)) and r["name"].lower().find("сотрудник") >= 0 \
                and t > ctx["dept_size"]:
            ctx["warnings"].append(f"цель «{r['name'][:50]}» = {int(t)}, а в отделе {ctx['dept_size']}")
    return out


def check_antimetrics(analysis, metrics, ctx):
    """Антиметрики, которые скилл может проверить сам."""
    wd = analysis.get("wave_diff") or {}
    res = []
    for am in metrics["antimetrics"]:
        verdict, detail = "не проверяется автоматически", am["trigger"]
        if _match(am["name"], "репозиторий-витрина") and ctx["repo_ok"]:
            n = len(ctx["dept_authors"])
            verdict = "СРАБОТАЛА" if n <= 2 else "в норме"
            detail = (f"авторов из отдела {n} (порог ≤ 2); переиспользование не видно без опроса — "
                      f"смотреть строку «Скиллов, использованных кем-то кроме автора»")
        elif _match(am["name"], "ложная уверенность"):
            cal = wd.get("calibration_mean")
            now = analysis["aggregate"].get("calibration_mean")
            if cal is None and now is None:
                verdict, detail = "не считается", "в волне нет самооценки (вопрос 511) — калибровки нет"
            elif cal is None:
                verdict, detail = "нет прошлой волны", f"сейчас разрыв {now:+} п.п."
            else:
                verdict = "СРАБОТАЛА" if cal >= 22 else "в норме"
                detail = f"разрыв изменился на {cal:+} п.п. (порог +22)"
        elif _match(am["name"], "зависимость от ии"):
            kn = wd.get("knowledge_pct_mean")
            if kn is None:
                verdict, detail = "нет прошлой волны", f"сейчас {analysis['aggregate']['knowledge_pct_mean']}% верных"
            else:
                verdict = "СРАБОТАЛА" if kn < 0 else "в норме"
                detail = f"знания изменились на {kn:+} п.п."
        res.append({"name": am["name"], "verdict": verdict, "detail": detail, "action": am["action"]})
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--analysis", required=True)
    ap.add_argument("--metrics-xlsx", help="локальная копия таблицы метрик (иначе скачается)")
    ap.add_argument("--dept", help="лист отдела (по умолчанию из config.json)")
    ap.add_argument("--date", help="дата столбца, куда вставлять (по умолчанию сегодня)")
    ap.add_argument("--csv", help="сохранить столбец в CSV")
    ap.add_argument("--repo-asof", help="считать репозиторий на дату ДД.ММ.ГГГГ (по умолчанию — сегодня)")
    ap.add_argument("--no-fetch", action="store_true", help="не обновлять клон ai-tools перед подсчётом")
    a = ap.parse_args()

    analysis = json.load(open(a.analysis, encoding="utf-8-sig"))
    xlsx = a.metrics_xlsx
    if not xlsx:
        xlsx = os.path.join(os.path.dirname(os.path.abspath(a.analysis)), "metrics_sheet.xlsx")
        L.fetch_metrics(xlsx)
        print("скачано ->", xlsx)
    metrics = L.parse_metrics(xlsx, a.dept)
    if not metrics["sheet"]:
        raise SystemExit(f"Лист отдела не найден. Есть: {metrics['available']}")

    column = a.date or datetime.date.today().strftime("%d.%m.%Y")
    asof = datetime.datetime.strptime(a.repo_asof, "%d.%m.%Y").date() if a.repo_asof else None
    ctx = build_context(analysis, metrics, asof, a.no_fetch)
    ctx["date"] = column
    rows = compute(ctx, metrics)

    print(f"\nЛист «{metrics['sheet']}» · столбец {column} · волна {analysis.get('wave', 1)}"
          f" · прошли {analysis['aggregate']['n']} чел. · в отделе {ctx['dept_size']} чел.")
    for w in ctx["warnings"]:
        print("ВНИМАНИЕ:", w)

    width = max(len(r["name"][:52]) for r in rows)
    print("\n" + "МЕТРИКА".ljust(width) + " | ВСТАВИТЬ | БЫЛО    | ЦЕЛЬ  | ОТКУДА")
    print("-" * (width + 46))
    for r in rows:
        val = "—" if r["computed"] is None else str(r["computed"])
        was = "—" if r["recorded"] in (None, "") else str(r["recorded"])
        tgt = "—" if r["target"] in (None, "") else str(r["target"])
        print(f"{r['name'][:52].ljust(width)} | {val:>8} | {was:>7} | {tgt:>5} | {r['note']}")

    changed = [r for r in rows if r["computed"] is not None and r["recorded"] not in (None, "")
               and abs(float(r["computed"]) - float(r["recorded"])) > 0.005]
    if changed:
        print("\nРасходится с записанным ранее:")
        for r in changed:
            print(f"  {r['name'][:60]}: было {r['recorded']} ({r['recorded_date']}) -> стало {r['computed']}")

    # --- мероприятия ---
    today = datetime.date.today()
    def parsed(d):
        try:
            return datetime.datetime.strptime(d, "%d.%m.%Y").date()
        except (ValueError, TypeError):
            return None
    overdue, upcoming, done = [], [], 0
    for ev in metrics["events"]:
        status = ev["status"].lower()
        d = parsed(ev["date"])
        if status.startswith("выполнено") or status == "готово":
            done += 1
        elif d and d < today:
            overdue.append(ev)
        elif d:
            upcoming.append(ev)
    print(f"\nМероприятия: выполнено {done}, просрочено {len(overdue)}, впереди {len(upcoming)}")
    for ev in overdue:
        print(f"  ПРОСРОЧЕНО {ev['date']} — {ev['name'][:70]} [{ev['status'] or 'без статуса'}]")
    for ev in sorted(upcoming, key=lambda e: parsed(e["date"]))[:5]:
        print(f"  {ev['date']} — {ev['name'][:70]}")

    # --- антиметрики ---
    print("\nАнтиметрики:")
    for am in check_antimetrics(analysis, metrics, ctx):
        mark = "!!!" if am["verdict"] == "СРАБОТАЛА" else "   "
        print(f"  {mark} {am['name'][:48]:48} {am['verdict']:26} {am['detail']}")
        if am["verdict"] == "СРАБОТАЛА":
            print(f"        что делаем: {am['action']}")

    if a.csv:
        with open(a.csv, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(["Метрика", column, "Было", "Цель", "Откуда"])
            for r in rows:
                w.writerow([r["name"], "" if r["computed"] is None else r["computed"],
                            r["recorded"], r["target"], r["note"]])
        print("\ncsv ->", a.csv)


if __name__ == "__main__":
    main()
