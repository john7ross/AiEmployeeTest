# -*- coding: utf-8 -*-
"""Fetch/parse the survey and produce a full analysis: per-employee decoded
profiles + department aggregates. Optional wave-over-wave diff.

Usage:
  python analyze.py --out DIR [--xlsx FILE | --fetch] [--sheet-id ID]
                    [--prev PREV_analysis.json] [--no-history] [--history-dir DIR]

By default the wave is saved into a persistent history dir (config.json -> history_dir)
and automatically compared against the most recent EARLIER wave — no need to remember
paths between surveys. Just run `analyze.py --fetch --out DIR` each wave.

Персональные наборы вопросов
----------------------------
Колонка «Ограничение (по ID пользователя)» на листе Questions задаёт, кому какой
вопрос показывается. Поэтому все доли считаются от числа тех, КОМУ ВОПРОС ЗАДАВАЛСЯ,
а знания — от личного набора человека (7/8 и 7/10 — разные вещи). Непрошенный
вопрос никогда не смешивается с пропущенным.

Writes DIR/analysis.json (machine) and DIR/analysis.txt (human, UTF-8, feed to the model).
"""
import os, json, argparse, glob, re
from collections import Counter, OrderedDict
import survey_lib as L

# 411 (персональные данные клиентов) обязан быть здесь: из него считается
# «осознанность при работе с чувствительными данными», и он печатается в разборе.
PREF_QS = ["511","201","202","203","204","205","206","207","208","209","210","411"]
ATT_QS  = ["101","102","103","104","105","106","107","108","109","110"]

# Вопросы, из которых считается портрет (js/config.js -> portrait.scores).
# Минимум ответов на характеристику берётся из листа Settings (ключ min_answers) —
# единый источник для фронтенда, бэкенда и статистики; config.json — запасной.
DIM_QS = {
    "adoption": ["101","102","104","106","107","108","109","110"],
    "interest": ["201","202","203","205","207","208","209","210"],
    "safety":   ["103","105","108","110","411"],
}

# Признаки вовлечённости с листа Usages (метрика «вовлечён» = хотя бы один «Да»).
USAGE_SIGNALS = ["Агент", "Подключил ai-tools", "Выложил артефакт", "Мероприятия", "Использует инструмент"]

# Разрыв «самооценка − факт» больше этого — переоценка себя (антиметрика «ложная уверенность»).
CALIB_GAP = L.CFG.get("calibration_gap", 20)


def build(data):
    ids = L.completed_ids(data)
    byid = {L.emp_id(e): e for e in data["employees"]}
    key = L.knowledge_key(data)
    mins = L.min_answers(data)
    usages = data.get("usages", {})
    people = []
    for eid in ids:
        e = byid[eid]; resp = data["responses"].get(str(eid), {})
        asked = L.questions_for(data, eid)
        asked_set = set(asked)
        kn = L.knowledge_score(resp, asked, key)
        num = lambda k: (float(e[k]) if str(e.get(k, "")).strip() not in ("", "None") else None)
        answered = [q for q in asked if resp.get(q, "") != ""]
        pct = round(100.0 * kn["correct"] / kn["total"]) if kn["total"] else None
        self_score = num("Балл самооценки")
        p = {
            "id": eid, "name": e.get("ФИО"), "role": e.get("Должность"), "dept": e.get("Отдел"),
            "portrait": e.get("Портрет"),
            "scores": {"avg": num("Средний балл на основе ответов"),
                       "adoption": num("Принятие/готовность использовать ИИ"),
                       "interest": num("Интерес и инициативность"),
                       "safety": num("Безопасность и ответственность"),
                       "self": self_score,
                       "knowledge_correct": kn["correct"], "knowledge_total": kn["total"],
                       "knowledge_pct": pct,
                       # Калибровка: насколько самооценка расходится с фактом.
                       # + переоценивает себя, − недооценивает (антиметрика «ложная уверенность»).
                       "calibration": (round(self_score - pct) if self_score is not None and pct is not None else None)},
            "knowledge_wrong": kn["wrong"], "knowledge_blank": kn["blank"], "knowledge_timeout": kn["timeout"],
            "asked": asked, "asked_n": len(asked), "answered_n": len(answered),
            "not_asked": [q for q in L.base_question_ids(data) if q not in asked_set],
            "short_dims": short_dimensions(asked_set, mins),
            "prefs": {q: (L.decode_answer(q, resp) if q in asked_set else "не задавался") for q in PREF_QS},
            "attitude": {q: (L.decode_answer(q, resp) if q in asked_set else "не задавался") for q in ATT_QS},
            "learning_format": resp.get("204", "") if "204" in asked_set else None,
            "ambassador": resp.get("205", "") if "205" in asked_set else None,
            "usage": usage_signals(usages.get(eid)),
        }
        people.append(p)
    return people


def usage_signals(row):
    """Признаки с листа Usages по одному человеку + признак «вовлечён»."""
    if not row:
        return None
    out = {s: str(row.get(s, "")).strip() for s in USAGE_SIGNALS}
    out["участвует"] = str(row.get("Участвует?", "")).strip()
    out["вовлечён"] = any(out[s].lower() == "да" for s in USAGE_SIGNALS)
    return out


def short_dimensions(asked_set, mins):
    """Характеристики, которым в наборе человека не хватает вопросов до minAnswers."""
    out = {}
    for dim, qs in DIM_QS.items():
        minimum = mins.get(dim, 0)
        have = len([q for q in qs if q in asked_set])
        if have < minimum:
            out[dim] = {"asked": have, "need": minimum}
    return out


def _share(counter, asked_n):
    """Доля от тех, кому вопрос задавался (а не от всех прошедших)."""
    return {k: (v, f"{round(100.0 * v / asked_n)}%" if asked_n else "—") for k, v in counter.items()}


def aggregate(data, people):
    n = len(people)
    mins = L.min_answers(data)

    def mean(key):
        vals = [p["scores"][key] for p in people if p["scores"][key] is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    def counted(key):
        return len([p for p in people if p["scores"][key] is not None])

    fmt = Counter(p["learning_format"] for p in people if p["learning_format"] is not None)
    fmt_asked = len([p for p in people if p["learning_format"] is not None])
    amb = [p for p in people if p["ambassador"] is not None]
    port = Counter((p["portrait"] or "без портрета") for p in people)

    kn_people = [p for p in people if p["scores"]["knowledge_total"]]
    kn_correct = [p["scores"]["knowledge_correct"] for p in kn_people]
    kn_pct = [p["scores"]["knowledge_pct"] for p in kn_people]

    asked_511 = [p for p in people if p["prefs"]["511"] != "не задавался"]

    # Калибровка: самооценка минус фактический процент знаний.
    calib = [p["scores"]["calibration"] for p in people if p["scores"]["calibration"] is not None]
    timeouts = [p for p in people if p["knowledge_timeout"]]

    # Вовлечённость с листа Usages (join по ID).
    with_usage = [p for p in people if p["usage"]]
    usage_counts = {s: len([p for p in with_usage if p["usage"][s].lower() == "да"]) for s in USAGE_SIGNALS}

    return {
        "n": n,
        "portrait": dict(port),
        "means": {k: mean(k) for k in ["avg","adoption","interest","safety"]},
        "means_counted": {k: counted(k) for k in ["avg","adoption","interest","safety"]},
        "knowledge_mean": round(sum(kn_correct)/len(kn_correct), 1) if kn_correct else None,
        "knowledge_pct_mean": round(sum(kn_pct)/len(kn_pct), 1) if kn_pct else None,
        "knowledge_dist": dict(sorted(Counter(kn_correct).items())),
        "knowledge_totals": dict(sorted(Counter(p["scores"]["knowledge_total"] for p in kn_people).items())),
        "format_pref": {"воркшопы(A)": fmt.get("A",0), "самостоятельно(B)": fmt.get("B",0),
                        "гибко(C)": fmt.get("C",0), "не задавался": n - fmt_asked},
        "format_pref_share": _share(Counter({"воркшопы(A)": fmt.get("A",0), "самостоятельно(B)": fmt.get("B",0),
                                             "гибко(C)": fmt.get("C",0)}), fmt_asked),
        "ambassadors_ready": [p["name"] for p in amb if p["ambassador"] == "A"],
        "ambassadors_asked": len(amb),
        # Считается СРЕДИ ПРОШЕДШИХ опрос (не от штата отдела) — так решено в проекте.
        "using_regularly": [p["name"] for p in asked_511 if p["prefs"]["511"].startswith("использует регулярно")],
        "using_regularly_asked": len(asked_511),
        "using_regularly_share": (round(100.0 * len([p for p in asked_511 if p["prefs"]["511"].startswith("использует регулярно")]) / len(asked_511))
                                  if asked_511 else None),
        # Калибровка (антиметрика «ложная уверенность»): + переоценка, − недооценка.
        "calibration_mean": round(sum(calib) / len(calib), 1) if calib else None,
        "calibration_counted": len(calib),
        "overconfident": [{"name": p["name"], "gap": p["scores"]["calibration"]}
                          for p in sorted(people, key=lambda x: -(x["scores"]["calibration"] or -999))
                          if (p["scores"]["calibration"] or 0) >= CALIB_GAP],
        "underconfident": [{"name": p["name"], "gap": p["scores"]["calibration"]}
                           for p in sorted(people, key=lambda x: (x["scores"]["calibration"] or 999))
                           if (p["scores"]["calibration"] or 0) <= -CALIB_GAP],
        "calibration_gap": CALIB_GAP,
        # Осознанность при работе с чувствительными данными (вопрос 411).
        "data_care": {
            "обезличил бы (B)": len([p for p in people if str(p["prefs"].get("411", "")).startswith("сначала обезличил")]),
            "не стал бы публичный ИИ (C)": len([p for p in people if str(p["prefs"].get("411", "")).startswith("не стал")]),
            "загрузил бы как есть (A)": len([p for p in people if str(p["prefs"].get("411", "")).startswith("загрузил")]),
            "не задавался": len([p for p in people if p["prefs"].get("411") == "не задавался"]),
            "свой ответ": len([p for p in people if str(p["prefs"].get("411", "")).startswith("(свой")]),
        },
        # Не успел (истёк таймер) — отдельно от «пропустил молча».
        "timeout_total": sum(len(p["knowledge_timeout"]) for p in people),
        "timeout_people": [{"name": p["name"], "questions": p["knowledge_timeout"]} for p in timeouts],
        "blank_total": sum(len(p["knowledge_blank"]) for p in people),
        # Вовлечённость с листа Usages.
        "usage_covered": len(with_usage),
        "usage_counts": usage_counts,
        "engaged": [p["name"] for p in with_usage if p["usage"]["вовлечён"]],
        "min_answers": mins,
        "question_base": L.base_question_ids(data),
        "restricted_questions": L.restricted_questions(data),
        "question_sets": question_sets(people),
        "coverage": coverage(data, people),
        "short_dim_people": [{"name": p["name"], "dims": p["short_dims"]} for p in people if p["short_dims"]],
        "no_portrait": [p["name"] for p in people if not p["portrait"]],
    }


def question_sets(people):
    """Сгруппировать людей по фактическому набору вопросов."""
    groups = OrderedDict()
    for p in people:
        sig = tuple(p["asked"])
        groups.setdefault(sig, []).append(p["name"])
    out = []
    for sig, names in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        out.append({"n": len(names), "questions": len(sig), "people": names, "ids": list(sig)})
    return out


def coverage(data, people):
    """По каждому вопросу: скольким задавали и сколько ответили."""
    out = {}
    for q in L.base_question_ids(data):
        asked = [p for p in people if q in p["asked"]]
        answered = [p for p in asked if data["responses"].get(str(p["id"]), {}).get(q, "") != ""]
        out[q] = {"asked": len(asked), "answered": len(answered),
                  "restriction": data["questions"][q]["restriction"] or ""}
    return out


def diff(cur, prev):
    if not prev:
        return None
    out = {"means": {}, "knowledge_mean": None, "knowledge_pct_mean": None,
           "calibration_mean": None, "portrait": {}, "questions": {}}
    for k, v in cur["means"].items():
        pv = prev.get("means", {}).get(k)
        if v is not None and pv is not None:
            out["means"][k] = round(v - pv, 1)
    for k in ("knowledge_mean", "knowledge_pct_mean", "calibration_mean"):
        if cur.get(k) is not None and prev.get(k) is not None:
            out[k] = round(cur[k] - prev[k], 1)
    for lab in set(list(cur["portrait"]) + list(prev.get("portrait", {}))):
        out["portrait"][lab] = cur["portrait"].get(lab, 0) - prev.get("portrait", {}).get(lab, 0)
    # Состав вопросов между волнами: что добавили, что убрали.
    cur_q, prev_q = set(cur.get("question_base", [])), set(prev.get("question_base", []))
    if prev_q:
        out["questions"] = {"added": sorted(cur_q - prev_q), "removed": sorted(prev_q - cur_q),
                            "same": cur_q == prev_q}
    return out


def wave_date(data):
    """Latest completion date among finished employees -> 'YYYY-MM-DD' (identifies the wave)."""
    ids = set(L.completed_ids(data)); best = ""
    for e in data["employees"]:
        if L.emp_id(e) in ids:
            d = str(e.get("Дата и время прохождения", "")).strip()[:10]
            if len(d) == 10 and d > best:
                best = d
    return best or "unknown"


def pick_prev(history_dir, cur_date, cur_wave):
    """Предыдущий срез из истории: сначала по номеру волны, при равных — по дате.

    Файлы старого формата (без номера волны) читаются по дате из имени, поэтому
    история, накопленная до внедрения волн, не теряется.
    """
    if not os.path.isdir(history_dir):
        return None
    best, best_key = None, None
    for f in glob.glob(os.path.join(history_dir, "wave_*.json")):
        wave, date = None, ""
        try:
            with open(f, encoding="utf-8-sig") as fh:
                snap = json.load(fh)
            wave = snap.get("wave")
            date = str(snap.get("wave_date", ""))
        except (OSError, ValueError):
            pass
        if not date:
            m = re.search(r"wave_(\d{4}-\d{2}-\d{2})", os.path.basename(f))
            date = m.group(1) if m else ""
        key = (wave if isinstance(wave, int) else 0, date)
        cur_key = (cur_wave, cur_date)
        if key >= cur_key:
            continue
        if best_key is None or key > best_key:
            best_key, best = key, f
    return best


def to_text(agg, people, notdone, wave_diff, meta=None):
    meta = meta or {}
    o = []
    head = f"АНАЛИЗ ОПРОСА — прошли: {agg['n']} чел."
    if meta.get("wave"):
        head += f" | волна {meta['wave']}"
        if meta.get("wave_date"):
            head += f" (последнее прохождение {meta['wave_date']})"
    o.append(head)
    if meta.get("scores_from_history"):
        o.append("Баллы и портреты взяты из архива Employees_history — это итоги именно этой волны.")
    o.append(f"Портрет: {agg['portrait']}")
    m, mc = agg["means"], agg["means_counted"]
    o.append(f"Средние: Итог {m['avg']} | Принятие {m['adoption']} | Интерес {m['interest']} | Безопасность {m['safety']}"
             f"   (посчитаны по {mc['avg']}/{agg['n']} чел.)")
    o.append(f"Знания: {agg['knowledge_pct_mean']}% верных в среднем "
             f"(в баллах {agg['knowledge_mean']}, распределение {agg['knowledge_dist']}, "
             f"размер блока у людей: {agg['knowledge_totals']})")
    o.append(f"Формат обучения: {agg['format_pref']}  доли среди спрошенных: {agg['format_pref_share']}")
    o.append(f"Готовые амбассадоры: {agg['ambassadors_ready']} (вопрос задавали {agg['ambassadors_asked']} чел.)")
    o.append(f"Регулярно используют ИИ: {len(agg['using_regularly'])} из {agg['using_regularly_asked']} прошедших "
             f"({agg['using_regularly_share']}%) — {agg['using_regularly']}")
    o.append(f"Данные клиентов (411): {agg['data_care']}"
             + ("   ВНИМАНИЕ: есть готовые загрузить как есть — нужен инструктаж"
                if agg["data_care"]["загрузил бы как есть (A)"] else ""))
    o.append(f"Не прошли (кроме теста): {[x['name'] for x in notdone]}")

    # --- калибровка: самооценка против факта ---
    o.append(f"\nКАЛИБРОВКА (самооценка − факт по знаниям), порог ±{agg['calibration_gap']} п.п.:")
    o.append(f"  Средний разрыв: {agg['calibration_mean']:+} п.п. (посчитан по {agg['calibration_counted']} чел.)"
             if agg["calibration_mean"] is not None else "  Нет данных для расчёта.")
    if agg["overconfident"]:
        o.append(f"  Переоценивают себя ({len(agg['overconfident'])} чел.): "
                 + ", ".join(f"{x['name']} {x['gap']:+}" for x in agg["overconfident"]))
    if agg["underconfident"]:
        o.append(f"  Недооценивают себя ({len(agg['underconfident'])} чел.): "
                 + ", ".join(f"{x['name']} {x['gap']:+}" for x in agg["underconfident"]))
    o.append("  Читать так: переоценка — кандидаты на разбор ошибок на реальных кейсах, а не на новые"
             " инструменты; недооценка — тем стоит вернуть уверенность (в портрете подать как сильную сторону).")

    # --- не успел ≠ не знал ---
    if agg["timeout_total"] or agg["blank_total"]:
        o.append(f"\nПРОПУСКИ В БЛОКЕ ЗНАНИЙ: не успел по таймеру — {agg['timeout_total']} отв., "
                 f"пусто без пометки — {agg['blank_total']} отв.")
        for x in agg["timeout_people"]:
            o.append(f"  не успел: {x['name']} — вопросы {x['questions']}")
        if agg["blank_total"]:
            o.append("  «Пусто без пометки» — это ответы, записанные до внедрения маркера таймаута:"
                     " различить «не знал» и «не успел» по ним нельзя.")

    # --- вовлечённость с листа Usages ---
    if agg["usage_covered"]:
        o.append(f"\nВОВЛЕЧЁННОСТЬ (лист Usages, связка по ID; покрыто {agg['usage_covered']} из {agg['n']} прошедших):")
        o.append(f"  По признакам: {agg['usage_counts']}")
        o.append(f"  Вовлечён хотя бы по одному признаку: {len(agg['engaged'])} чел. — {agg['engaged']}")

    # --- персональные наборы вопросов ---
    sets = agg["question_sets"]
    if agg["restricted_questions"] or len(sets) > 1:
        o.append("\nНАБОРЫ ВОПРОСОВ (колонка «Ограничение (по ID пользователя)»):")
        if agg["restricted_questions"]:
            for q, label in sorted(agg["restricted_questions"].items()):
                cov = agg["coverage"].get(q, {})
                o.append(f"  {q}: {label} — задан {cov.get('asked','?')} чел., ответили {cov.get('answered','?')}")
        else:
            o.append("  (ограничений в таблице нет)")
        o.append(f"  Вариантов набора: {len(sets)}")
        for s in sets:
            names = ", ".join(s["people"][:6]) + ("…" if len(s["people"]) > 6 else "")
            o.append(f"    {s['questions']} вопр. — {s['n']} чел.: {names}")
        o.append("  ВАЖНО: доли выше считаются от числа тех, кому вопрос задавался, а знания — "
                 "от личного набора (проценты сравнимы, «баллы из N» — нет).")
    if agg["short_dim_people"]:
        o.append("  ВНИМАНИЕ: у этих людей набор короче минимума для характеристики — "
                 "балл не считается и портрет может быть пустым:")
        for x in agg["short_dim_people"]:
            dims = ", ".join(f"{d}: {v['asked']}/{v['need']}" for d, v in x["dims"].items())
            o.append(f"    {x['name']} — {dims}")
    if agg["no_portrait"]:
        o.append(f"  Без портрета (нет итогового балла): {agg['no_portrait']}")

    if wave_diff:
        o.append("\nИЗМЕНЕНИЯ К ПРОШЛОЙ ВОЛНЕ:")
        o.append(f"  Средние Δ: {wave_diff['means']}  | Знания Δ: {wave_diff['knowledge_pct_mean']} п.п.  "
                 f"| Калибровка Δ: {wave_diff['calibration_mean']} п.п.  | Портрет Δ: {wave_diff['portrait']}")
        cal = wave_diff.get("calibration_mean")
        if cal is not None and cal >= 22:
            o.append("  АНТИМЕТРИКА «ложная уверенность»: разрыв самооценки и факта вырос на ≥22 п.п. "
                     "— разбор ошибок на реальных кейсах, а не новые инструменты.")
        q = wave_diff.get("questions") or {}
        if q and not q.get("same", True):
            o.append(f"  Состав вопросов изменился: добавлены {q.get('added')}, убраны {q.get('removed')}. "
                     "Сравнивать средние по знаниям можно только в процентах.")
        flags = [k for k, v in wave_diff["means"].items() if v is not None and v <= -5]
        if flags:
            o.append(f"  ВНИМАНИЕ: снижение по: {flags} — стоит разобраться в причинах.")

    o.append("\n--- ПО СОТРУДНИКАМ (для написания портретов) ---")
    agg_gap = agg["calibration_gap"]
    for p in people:
        s = p["scores"]
        o.append(f"\n#{p['id']} {p['name']} — {p['role']}")
        o.append(f"  Портрет:{p['portrait']} | Принятие:{s['adoption']} Интерес:{s['interest']} Безоп:{s['safety']} "
                 f"| Знания:{s['knowledge_correct']}/{s['knowledge_total']} ({s['knowledge_pct']}%)")
        cal = s["calibration"]
        if cal is not None:
            hint = ("переоценивает себя" if cal >= agg_gap else
                    "недооценивает себя" if cal <= -agg_gap else "оценивает себя точно")
            o.append(f"  Самооценка {s['self']} против факта {s['knowledge_pct']}% -> разрыв {cal:+} п.п. ({hint})")
        if p["knowledge_timeout"]:
            o.append(f"  Не успел по таймеру: {p['knowledge_timeout']} — это не незнание, а нехватка времени")
        if p["usage"]:
            marks = ", ".join(f"{k}: {v}" for k, v in p["usage"].items() if k in USAGE_SIGNALS and v)
            o.append(f"  Usages: вовлечён={'да' if p['usage']['вовлечён'] else 'нет'} | {marks}")
        o.append(f"  Набор: {p['asked_n']} вопр., ответил на {p['answered_n']}"
                 + (f" | НЕ ЗАДАВАЛИСЬ: {p['not_asked']}" if p["not_asked"] else ""))
        if p["short_dims"]:
            o.append(f"  ! короткий набор для: {', '.join(p['short_dims'])} — часть баллов не посчиталась")
        o.append(f"  Самооценка(511): {p['prefs']['511']}")
        o.append(f"  Формат(204): {p['prefs']['204']} | Тема(203): {p['prefs']['203']} | Глубина(209): {p['prefs']['209']} | Встроенность(206): {p['prefs']['206']}")
        o.append(f"  Амбассадор(205): {p['prefs']['205']} | Час(201): {p['prefs']['201']} | Нов.инстр(202): {p['prefs']['202']} | Самообуч(207): {p['prefs']['207']} | Мероприятия(210): {p['prefs']['210']}")
        o.append(f"  Отношение: 101:{p['attitude']['101']} | 104:{p['attitude']['104']} | 106:{p['attitude']['106']} | 107:{p['attitude']['107']} | 109:{p['attitude']['109']}")
        o.append(f"  Безопасность: 103:{p['attitude']['103']} | 108:{p['attitude']['108']} | 110:{p['attitude']['110']} | 411:{p['prefs'].get('411','—')}")
    return "\n".join(o)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--xlsx")
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--sheet-id")
    ap.add_argument("--prev", help="force a specific previous analysis.json (else auto from history)")
    ap.add_argument("--no-history", action="store_true", help="don't read/write the wave history")
    ap.add_argument("--history-dir", help="override config.json history_dir")
    ap.add_argument("--wave", type=int, help="разобрать конкретную волну (по умолчанию — текущая из Settings)")
    ap.add_argument("--list-waves", action="store_true", help="показать, какие волны есть в таблице, и выйти")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    xlsx = a.xlsx
    if a.fetch or not xlsx:
        xlsx = os.path.join(a.out, "live_sheet.xlsx")
        L.fetch_sheet(xlsx, a.sheet_id)
        print("fetched ->", xlsx)

    data = L.parse(xlsx)

    if a.list_waves:
        print("колонка «Волна» в Results:", "есть" if data["has_wave_column"] else "НЕТ (всё считается волной 1)")
        print("текущая волна (Settings ▸ wave):", data["wave"])
        for w in data["waves"]:
            n = len(data["responses_by_wave"][w])
            arch = len(data.get("history", {}).get(w, {}))
            print(f"  волна {w}: ответы у {n} чел." + (f", итоги в архиве у {arch}" if arch else ""))
        return

    if a.wave and a.wave != data["wave"]:
        if a.wave not in data["responses_by_wave"]:
            raise SystemExit(f"В таблице нет ответов волны {a.wave}. Доступны: {data['waves']}")
        data = L.select_wave(data, a.wave)
        src = "из архива Employees_history" if data.get("scores_from_history") else \
              "ИЗ ТЕКУЩЕГО Employees — итоги относятся к последней волне, а не к запрошенной"
        print(f"разбираю волну {a.wave}; баллы и портреты — {src}")

    people = build(data)
    if not people:
        print("Опрос никто не завершил: в Employees нет строк со статусом «Использован» "
              "(или все они помечены как тестовые в config.json → test_employee_ids).\n"
              "Если это структурный шаблон таблицы — так и должно быть, считать пока нечего.")
    agg = aggregate(data, people)
    notdone = L.not_completed(data)
    wdate = wave_date(data)
    hist_dir = a.history_dir or L.CFG.get("history_dir")

    bad = {q: data["questions"][q]["rule"]["bad"] for q in data["questions"] if data["questions"][q]["rule"]["bad"]}
    if bad:
        print("ВНИМАНИЕ: непонятные значения в колонке ограничений (вопрос -> токены):", bad)

    wnum = data["wave"]

    # Choose previous wave: explicit --prev wins, else auto from history.
    prev_path = a.prev
    if not prev_path and not a.no_history and hist_dir:
        prev_path = pick_prev(hist_dir, wdate, wnum)
    prev = json.load(open(prev_path, encoding="utf-8-sig"))["aggregate"] if prev_path else None
    wave = diff(agg, prev)

    out = {"wave": wnum, "wave_date": wdate,
           "prev_wave": os.path.basename(prev_path) if prev_path else None,
           "has_wave_column": data["has_wave_column"],
           "scores_from_history": data.get("scores_from_history", False),
           "aggregate": agg, "people": people, "not_completed": notdone, "wave_diff": wave,
           "restriction_errors": bad}
    json.dump(out, open(os.path.join(a.out, "analysis.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)

    # Persist this wave into history so the NEXT survey auto-compares against it.
    if not a.no_history and hist_dir:
        os.makedirs(hist_dir, exist_ok=True)
        hfile = os.path.join(hist_dir, f"wave_{wdate}_w{wnum}_{agg['n']}p.json")
        json.dump(out, open(hfile, "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
        print("history ->", hfile, "| compared with:", out["prev_wave"] or "(первая волна, сравнивать не с чем)")
    if not data["has_wave_column"]:
        print("ВНИМАНИЕ: в Results нет колонки «Волна» — ответы новой волны перезапишут прошлые. "
              "Запустите setupWaveColumn() в Apps Script.")

    txt = to_text(agg, people, notdone, wave, out)
    open(os.path.join(a.out, "analysis.txt"), "w", encoding="utf-8").write(txt)
    print("wrote analysis.json + analysis.txt to", a.out)
    print("\n" + txt[:1600])


if __name__ == "__main__":
    main()
