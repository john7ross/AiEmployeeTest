# -*- coding: utf-8 -*-
"""Собрать дашборд «пульс отдела» из analysis.json + текстов, написанных моделью.

Разделение труда то же, что и с портретами: ЦИФРЫ считает код (их нельзя
переписывать руками — так и появляются расхождения между дашбордом и данными),
СМЫСЛ пишет модель в story.json.

Usage:
  python make_dashboard.py --analysis DIR/analysis.json --story story.json --out DIR/dashboard.html
  python make_dashboard.py --analysis DIR/analysis.json --story-template story.json   # заготовка

story.json:
  {
    "wave_label": "Волна 2 · август 2026",
    "title": "Как отдел встречает ИИ-инструменты",
    "subtitle": "…1–2 предложения…",
    "dept": "Отдел аналитики",
    "headline_notes": {"avg": "уверенно выше середины", "using": "…", "format": "…", "ambassadors": "…"},
    "portrait_note": "…подпись под диаграммой распределения…",
    "findings":        [{"title": "…", "text": "…", "accent": "green|warm|cool"}, …],
    "recommendations": [{"title": "…", "text": "…"}, …],
    "people":          [{"id": 2, "short": "в двух словах", "focus": "мягкий фокус"}, …]
  }
Любой блок можно опустить — раздел просто не попадёт в страницу.
"""
import os, json, html, argparse
from collections import Counter

ACCENTS = {"green": "var(--green2)", "warm": "var(--warm)", "cool": "var(--cool)"}
FORMAT_PILL = {"A": ("f", "Воркшопы"), "B": ("s", "Самостоятельно"), "C": ("f", "Гибко")}

CSS = """
:root{
  --ground:#F5F8F6; --surface:#ffffff; --surface2:#eef3f0;
  --ink:#182119; --muted:#5b6b61; --faint:#8a988f;
  --green:#005C32; --green2:#0a7a45; --mint:#E6EFEB; --line:#dde6e0;
  --good:#0a7a45; --warm:#b8791f; --cool:#2f6f7a;
  --r:14px; --maxw:1080px;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#0d1310; --surface:#141d18; --surface2:#18231d;
  --ink:#e7efe9; --muted:#9db0a4; --faint:#6f8478;
  --green:#4bbd82; --green2:#5fce93; --mint:#1d2c24; --line:#26332b;
  --good:#4bbd82; --warm:#d6a24a; --cool:#79b9c4; }}
:root[data-theme="dark"]{
  --ground:#0d1310; --surface:#141d18; --surface2:#18231d;
  --ink:#e7efe9; --muted:#9db0a4; --faint:#6f8478;
  --green:#4bbd82; --green2:#5fce93; --mint:#1d2c24; --line:#26332b; --warm:#d6a24a; --cool:#79b9c4;}
:root[data-theme="light"]{
  --ground:#F5F8F6; --surface:#ffffff; --surface2:#eef3f0;
  --ink:#182119; --muted:#5b6b61; --faint:#8a988f;
  --green:#005C32; --green2:#0a7a45; --mint:#E6EFEB; --line:#dde6e0; --warm:#b8791f; --cool:#2f6f7a;}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font-family:system-ui,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.55;
  -webkit-font-smoothing:antialiased;}
.wrap{max-width:var(--maxw);margin:0 auto;padding:40px 24px 72px;}
.eyebrow{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--green);font-weight:700;}
h1{font-size:clamp(26px,4vw,38px);line-height:1.1;margin:10px 0 8px;letter-spacing:-.02em;text-wrap:balance;font-weight:800;}
.sub{color:var(--muted);font-size:15px;max-width:60ch;}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px;}
.tag{background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:5px 13px;font-size:12.5px;color:var(--muted);}
.tag b{color:var(--ink);font-weight:700;}
h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);
  font-weight:700;margin:52px 0 18px;padding-bottom:10px;border-bottom:1px solid var(--line);}
.grid{display:grid;gap:16px;}
.m4{grid-template-columns:repeat(4,1fr);}
.m3{grid-template-columns:repeat(3,1fr);}
.m2{grid-template-columns:repeat(2,1fr);}
@media(max-width:820px){.m4{grid-template-columns:repeat(2,1fr)}.m3,.m2{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:20px;}
.stat .n{font-size:34px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1;}
.stat .l{font-size:13px;color:var(--muted);margin-top:8px;}
.stat .s{font-size:12px;color:var(--faint);margin-top:2px;}
.meter{margin-top:14px;}
.meter .top{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;}
.meter .top b{font-size:20px;font-variant-numeric:tabular-nums;}
.bar{height:8px;border-radius:6px;background:var(--surface2);margin-top:7px;overflow:hidden;}
.bar>span{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,var(--green2),var(--green));}
.split{display:flex;height:34px;border-radius:9px;overflow:hidden;border:1px solid var(--line);margin-top:6px;}
.split>div{display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700;}
.finding{display:flex;gap:14px;align-items:flex-start;}
.finding .k{flex:0 0 6px;align-self:stretch;border-radius:4px;background:var(--green2);}
.finding h3{margin:0 0 5px;font-size:15.5px;}
.finding p{margin:0;color:var(--muted);font-size:13.5px;}
.rec{counter-reset:r;display:grid;gap:12px;}
.rec .card{display:flex;gap:16px;align-items:flex-start;}
.rec .card::before{counter-increment:r;content:counter(r,decimal-leading-zero);
  font-variant-numeric:tabular-nums;font-weight:800;color:var(--green);font-size:15px;
  border:1px solid var(--line);border-radius:8px;padding:4px 9px;background:var(--surface2);}
.rec h3{margin:0 0 4px;font-size:15px;}
.rec p{margin:0;color:var(--muted);font-size:13.5px;}
table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--surface);
  border:1px solid var(--line);border-radius:var(--r);overflow:hidden;}
thead th{text-align:left;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--faint);font-weight:700;padding:13px 16px;border-bottom:1px solid var(--line);}
tbody td{padding:13px 16px;border-bottom:1px solid var(--line);vertical-align:top;}
tbody tr:last-child td{border-bottom:none;}
tbody tr:hover{background:var(--surface2);}
td .nm{font-weight:700;}
td .rl{color:var(--faint);font-size:12px;}
.pill{display:inline-block;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap;}
.pill.w{background:color-mix(in srgb,var(--warm) 15%,transparent);color:var(--warm);}
.pill.s{background:color-mix(in srgb,var(--cool) 16%,transparent);color:var(--cool);}
.pill.f{background:var(--mint);color:var(--green);}
.tabwrap{overflow-x:auto;}
.note{color:var(--faint);font-size:12.5px;margin-top:14px;line-height:1.6;}
.delta{font-size:12px;font-weight:700;}
.delta.up{color:var(--good);} .delta.down{color:var(--warm);}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--faint);font-size:12.5px;text-align:center;}
"""


def e(s):
    return html.escape(str(s), quote=False)


def delta_badge(value, suffix=" п.п."):
    """Значок изменения к прошлой волне."""
    if value is None:
        return ""
    cls = "up" if value > 0 else ("down" if value < 0 else "")
    sign = f"{value:+g}"
    return f' <span class="delta {cls}">{sign}{suffix}</span>'


def stat(n, unit, label, note, delta=None):
    u = f'<span style="font-size:18px">{e(unit)}</span>' if unit else ""
    return (f'<div class="card stat"><div class="n">{e(n)}{u}</div>'
            f'<div class="l">{e(label)}{delta_badge(delta)}</div><div class="s">{e(note)}</div></div>')


def meter(label, value):
    v = 0 if value is None else max(0, min(100, value))
    return (f'<div class="meter"><div class="top"><span>{e(label)}</span><b>{round(v)}</b></div>'
            f'<div class="bar"><span style="width:{round(v)}%"></span></div></div>')


def build(analysis, story):
    agg = analysis["aggregate"]
    people = analysis["people"]
    wd = analysis.get("wave_diff") or {}
    notes = story.get("headline_notes", {})
    n = agg["n"]

    # --- шапка ---
    parts = ['<div class="wrap">']
    parts.append(f'<div class="eyebrow">Пульс внедрения ИИ · {e(story.get("wave_label", analysis.get("wave_date", "")))}</div>')
    parts.append(f'<h1>{e(story.get("title", "Как отдел встречает ИИ-инструменты"))}</h1>')
    if story.get("subtitle"):
        parts.append(f'<p class="sub">{e(story["subtitle"])}</p>')
    tags = [f'<span class="tag"><b>{n}</b> сотрудников прошли опрос</span>']
    if story.get("dept"):
        tags.append(f'<span class="tag">{e(story["dept"])}</span>')
    if story.get("wave_label"):
        tags.append(f'<span class="tag">{e(story["wave_label"])}</span>')
    nd = len(analysis.get("not_completed", []))
    tags.append(f'<span class="tag">{nd} не участвовали · тестовый профиль исключён</span>')
    parts.append('<div class="meta">' + "".join(tags) + "</div>")

    # --- общая картина: только считанные цифры ---
    using = len(agg["using_regularly"])
    fmt = agg["format_pref"]
    top_fmt = max(("воркшопы(A)", "самостоятельно(B)", "гибко(C)"), key=lambda k: fmt.get(k, 0))
    parts.append("<h2>Общая картина</h2><div class=\"grid m4\">")
    parts.append(stat(round(agg["means"]["avg"] or 0), "/100", "Средняя вовлечённость в тему ИИ",
                      notes.get("avg", ""), (wd.get("means") or {}).get("avg")))
    parts.append(stat(using, f"из {agg['using_regularly_asked']}", "регулярно применяют ИИ в работе",
                      notes.get("using", "верхний уровень шкалы использования")))
    parts.append(stat(fmt.get(top_fmt, 0), f"из {n}", f"предпочитают: {top_fmt.split('(')[0]}",
                      notes.get("format", "")))
    parts.append(stat(len(agg["ambassadors_ready"]), "", "готовых «проводников ИИ»",
                      notes.get("ambassadors", "ядро, на которое можно опереться")))
    parts.append("</div>")

    # --- портреты + три опоры ---
    port = agg["portrait"]
    total = sum(port.values()) or 1
    colors = {"Энтузиаст": "linear-gradient(90deg,var(--green),var(--green2))",
              "Конформист": "var(--faint)", "Оппонент": "var(--warm)", "без портрета": "var(--surface2)"}
    segs = "".join(
        f'<div style="width:{round(100.0 * v / total)}%;background:{colors.get(k, "var(--faint)")}">{e(k)} · {v}</div>'
        for k, v in sorted(port.items(), key=lambda kv: -kv[1]) if v)
    parts.append('<div class="grid m2" style="margin-top:16px"><div class="card">')
    parts.append('<div style="font-size:13px;color:var(--muted);font-weight:600">Распределение по отношению к ИИ</div>')
    parts.append(f'<div class="split">{segs}</div>')
    if story.get("portrait_note"):
        parts.append(f'<div class="note">{e(story["portrait_note"])}</div>')
    parts.append('</div><div class="card">')
    parts.append('<div style="font-size:13px;color:var(--muted);font-weight:600;margin-bottom:6px">Три опоры готовности</div>')
    for label, key in (("Интерес и активное участие", "interest"),
                       ("Бережность к данным", "safety"),
                       ("Принятие в повседневную работу", "adoption")):
        parts.append(meter(label, agg["means"][key]))
    parts.append("</div></div>")

    # --- знания и калибровка ---
    parts.append("<h2>Знания и самооценка</h2><div class=\"grid m4\">")
    parts.append(stat(agg["knowledge_pct_mean"], "%", "верных ответов в блоке знаний",
                      "в среднем по отделу", wd.get("knowledge_pct_mean")))
    parts.append(stat(f'{agg["calibration_mean"]:+g}' if agg["calibration_mean"] is not None else "—", " п.п.",
                      "разрыв «самооценка − факт»",
                      "плюс — люди оценивают себя выше результата", wd.get("calibration_mean")))
    parts.append(stat(len(agg["overconfident"]), f"из {agg['calibration_counted']}",
                      f"переоценивают себя на ≥{agg['calibration_gap']} п.п.",
                      "кандидаты на разбор ошибок, а не на новые инструменты"))
    parts.append(stat(len(agg["engaged"]) if agg["usage_covered"] else "—",
                      f"из {agg['usage_covered']}" if agg["usage_covered"] else "",
                      "вовлечены по листу Usages",
                      "агент, репозиторий, артефакт, мероприятия"))
    parts.append("</div>")

    # --- выводы и рекомендации (текст модели) ---
    if story.get("findings"):
        parts.append('<h2>Что показал опрос</h2><div class="grid" style="gap:14px">')
        for f in story["findings"]:
            accent = ACCENTS.get(f.get("accent", "green"), ACCENTS["green"])
            parts.append(f'<div class="card finding"><div class="k" style="background:{accent}"></div>'
                         f'<div><h3>{e(f.get("title", ""))}</h3><p>{e(f.get("text", ""))}</p></div></div>')
        parts.append("</div>")
    if story.get("recommendations"):
        parts.append('<h2>Что с этим делать дальше</h2><div class="rec">')
        for r in story["recommendations"]:
            parts.append(f'<div class="card"><div><h3>{e(r.get("title", ""))}</h3>'
                         f'<p>{e(r.get("text", ""))}</p></div></div>')
        parts.append("</div>")

    # --- таблица людей: имя/роль/формат из данных, две колонки текста от модели ---
    by_id = {p["id"]: p for p in people}
    rows = []
    for item in story.get("people", []):
        p = by_id.get(item.get("id"))
        if not p:
            continue
        cls, name_fmt = FORMAT_PILL.get(p["learning_format"], ("s", "не задавался"))
        parts_name = str(p["name"]).split()
        display = " ".join(parts_name[1:] + parts_name[:1]) if len(parts_name) > 1 else p["name"]
        rows.append(f'<tr><td><div class="nm">{e(display)}</div><div class="rl">{e(p["role"])}</div></td>'
                    f'<td>{e(item.get("short", ""))}</td>'
                    f'<td><span class="pill {cls}">{e(name_fmt)}</span></td>'
                    f'<td>{e(item.get("focus", ""))}</td></tr>')
    if rows:
        parts.append('<h2>Персональные портреты · кому что ближе</h2><div class="tabwrap"><table>')
        parts.append('<thead><tr><th>Сотрудник</th><th>В двух словах</th><th>Формат</th><th>Мягкий фокус</th></tr></thead><tbody>')
        parts.extend(rows)
        parts.append("</tbody></table></div>")
        parts.append('<div class="note">Полный портрет по каждому сотруднику — в персональном PDF (папка <b>pdf/</b>), '
                     'по одному листу А4. Формулировки мягкие: пробелы поданы как точки роста, без цифр и сравнений между людьми.</div>')

    # --- сноска про персональные наборы вопросов ---
    if agg.get("restricted_questions"):
        limits = ", ".join(f"{q} — {label}" for q, label in sorted(agg["restricted_questions"].items()))
        parts.append(f'<div class="note">Вопросы раздавались персонально ({limits}), поэтому доли считаются '
                     f'от числа тех, кому вопрос задавался, а знания — от личного набора. '
                     f'Вариантов набора: {len(agg["question_sets"])}.</div>')

    parts.append('<footer>Внутренний материал · подготовлено для контроля внедрения ИИ · '
                 'цифры собраны из analysis.json автоматически</footer></div>')
    title = story.get("title", "Пульс внедрения ИИ")
    return f"<title>{e(title)}</title>\n<style>{CSS}</style>\n" + "\n".join(parts) + "\n"


TEMPLATE = {
    "wave_label": "Волна N · месяц год",
    "title": "Как отдел встречает ИИ-инструменты",
    "subtitle": "Одно-два предложения: что это за разбор и зачем читателю смотреть.",
    "dept": "Отдел аналитики",
    "headline_notes": {"avg": "", "using": "", "format": "", "ambassadors": ""},
    "portrait_note": "Подпись под диаграммой распределения.",
    "findings": [{"title": "Заголовок вывода", "text": "2–3 предложения по делу.", "accent": "green"}],
    "recommendations": [{"title": "Что сделать", "text": "Коротко и конкретно."}],
    "people": [{"id": 2, "short": "в двух словах", "focus": "мягкий фокус"}],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--analysis", required=True)
    ap.add_argument("--story")
    ap.add_argument("--out")
    ap.add_argument("--story-template", help="записать заготовку story.json и выйти")
    a = ap.parse_args()

    analysis = json.load(open(a.analysis, encoding="utf-8-sig"))
    if a.story_template:
        tpl = dict(TEMPLATE)
        tpl["people"] = [{"id": p["id"], "short": "", "focus": ""} for p in analysis["people"]]
        json.dump(tpl, open(a.story_template, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("заготовка ->", a.story_template, "— заполнить и запустить с --story")
        return
    if not a.story or not a.out:
        raise SystemExit("нужны --story story.json и --out dashboard.html (или --story-template FILE)")

    story = json.load(open(a.story, encoding="utf-8-sig"))
    doc = build(analysis, story)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    open(a.out, "w", encoding="utf-8").write(doc)
    print("dashboard ->", a.out, f"({len(doc)} симв.)")

    missing = [p["name"] for p in analysis["people"]
               if p["id"] not in {i.get("id") for i in story.get("people", [])}]
    if missing:
        print("в таблице портретов нет:", missing)


if __name__ == "__main__":
    main()
