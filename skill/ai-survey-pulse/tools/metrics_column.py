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
import os, json, argparse, csv, datetime
import survey_lib as L

# Соответствие строк листа отдела и того, что умеет посчитать скилл.
# key -> (подстрока названия строки, функция от (agg, people), пояснение)
SURVEY_METRICS = [
    ("Доля регулярно использующих ИИ",
     lambda a, p: _share(len(a["using_regularly"]), a["n"]),
     "верхний уровень шкалы 511, среди прошедших опрос"),
    ("Доля энтузиастов",
     lambda a, p: _share(a["portrait"].get("Энтузиаст", 0), a["n"]),
     "портрет «Энтузиаст» (средний балл > 70)"),
    ("Количество сотрудников, вовлеченных в развитие",
     lambda a, p: (_share(len(a["engaged"]), a["usage_covered"]) if a["usage_covered"] else None),
     "хотя бы один признак «Да» на листе Usages"),
    ("Процент верных ответов в опросе сотрудника",
     lambda a, p: (round(a["knowledge_pct_mean"] / 100, 2) if a["knowledge_pct_mean"] is not None else None),
     "средняя доля верных в знаниевом блоке"),
    ("Осознанность при работе с чувствительными данными",
     lambda a, p: _share(a["data_care"]["обезличил бы (B)"], a["n"]),
     "вопрос 411, вариант «сначала обезличу»"),
    ("Субъективная экономия времени",
     lambda a, p: None,
     "вопроса в анкете нет — добавить перед волной"),
]

# Показатели: считаются с листа Usages, остальное — из репозитория/Битрикса.
USAGE_METRICS = [
    ("Сотрудников с настроенным ИИ-агентом", "Агент"),
    ("Сотрудников, подключивших общий репозиторий", "Подключил ai-tools"),
    ("Количество сотрудников, загрузивших артефакт в репозиторий", "Выложил артефакт"),
    ("Количество сотрудников, использующих хотя бы один ии-инструмент", "Использует инструмент"),
]


def _share(part, whole):
    return round(part / whole, 2) if whole else None


def _match(name, needle):
    return needle.lower() in " ".join(str(name).split()).lower()


def last_recorded(row):
    """Последнее заполненное значение строки и дата этого столбца."""
    for date in reversed(list(row["values"])):
        return date, row["values"][date]
    return None, None


def compute(analysis, metrics):
    agg, people = analysis["aggregate"], analysis["people"]
    usage_counts = agg.get("usage_counts", {})
    out = []

    survey_block = next((b for k, b in metrics["blocks"].items() if k.startswith("Метрики. Опрос")), None)
    ind_block = next((b for k, b in metrics["blocks"].items() if k.startswith("Метрики. Показатели")), None)

    for block, kind in ((survey_block, "опрос"), (ind_block, "показатель")):
        if not block:
            continue
        for row in block["rows"]:
            value, note = None, ""
            if kind == "опрос":
                for needle, fn, hint in SURVEY_METRICS:
                    if _match(row["name"], needle):
                        value, note = fn(agg, people), hint
                        break
            else:
                for needle, signal in USAGE_METRICS:
                    if _match(row["name"], needle):
                        value = usage_counts.get(signal)
                        note = f"лист Usages, признак «{signal}» = Да"
                        break
                if value is None and not note:
                    note = f"считается вне опроса ({row['source'] or 'источник не указан'})"
            date, recorded = last_recorded(row)
            out.append({"block": kind, "name": row["name"], "computed": value,
                        "recorded": recorded, "recorded_date": date,
                        "target": row["target"], "note": note})
    return out


def check_antimetrics(analysis, metrics):
    """Антиметрики, которые скилл может проверить сам."""
    wd = analysis.get("wave_diff") or {}
    res = []
    for am in metrics["antimetrics"]:
        verdict, detail = "не проверяется автоматически", am["trigger"]
        if _match(am["name"], "ложная уверенность"):
            cal = wd.get("calibration_mean")
            if cal is None:
                verdict, detail = "нет прошлой волны", f"сейчас разрыв {analysis['aggregate']['calibration_mean']:+} п.п."
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
    rows = compute(analysis, metrics)

    print(f"\nЛист «{metrics['sheet']}» · столбец {column} · волна {analysis.get('wave', 1)}"
          f" · прошли {analysis['aggregate']['n']} чел.")
    if metrics.get("dept_size"):
        print(f"В отделе по таблице: {metrics['dept_size']} чел.")

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
    for am in check_antimetrics(analysis, metrics):
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
