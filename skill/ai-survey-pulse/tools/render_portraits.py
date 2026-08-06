# -*- coding: utf-8 -*-
"""Render one A4 PDF per employee from a portraits JSON the model writes.

Deterministic layout (brand: Raleway-ish system stack, green #005C32) so prose
stays the only thing that changes wave to wave.

Input JSON: a list of objects, each:
  {id, name, role, dept, lead, anchor, scenarios, learning, natural, focus, principle?}

Usage:
  python render_portraits.py --portraits portraits.json --out DIR [--no-pdf]

Writes DIR/html/NN_Family.html and DIR/pdf/NN_Family.pdf
"""
import os, re, json, html, argparse, subprocess, glob, shutil

CSS = """
:root{--green:#005C32;--green2:#0a7a45;--mint:#E6EFEB;--paper:#F0F3F7;--ink:#213028;--muted:#5c6b62;}
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4;margin:0}
html,body{font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.page{width:210mm;min-height:297mm;padding:15mm 16mm 12mm;position:relative;display:flex;flex-direction:column;}
.topbar{position:absolute;top:0;left:0;right:0;height:8mm;background:linear-gradient(90deg,var(--green),var(--green2));}
.eyebrow{font-size:9pt;letter-spacing:.16em;text-transform:uppercase;color:var(--green);font-weight:700;margin-bottom:4px;}
.name{font-size:25pt;font-weight:800;line-height:1.05;color:var(--green);letter-spacing:-.01em;}
.role{font-size:10.5pt;color:var(--muted);margin-top:6px;font-weight:600;}
.rule{height:3px;width:52px;background:var(--green2);border-radius:3px;margin:14px 0 12px;}
.lead{font-size:11pt;line-height:1.55;background:var(--paper);border-left:4px solid var(--green);border-radius:10px;padding:13px 16px;color:#2a3a30;}
.anchor{font-size:10pt;line-height:1.5;margin:13px 0 4px;color:var(--muted);}
.anchor b{color:var(--green);font-weight:700;}
.sec{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid #e4eae6;}
.sec:last-child{border-bottom:none;}
.chip{flex:0 0 34px;height:34px;border-radius:9px;background:var(--mint);display:flex;align-items:center;justify-content:center;font-size:16pt;line-height:1;}
.sec .body{flex:1;}
.sec h3{font-size:10.5pt;color:var(--green);font-weight:700;margin-bottom:3px;}
.sec p{font-size:10pt;line-height:1.5;color:#33443a;}
.footer{margin-top:auto;padding-top:14px;}
.thanks{font-size:10.5pt;line-height:1.55;color:#2a3a30;background:linear-gradient(90deg,#eef5f1,#f5f8f6);border-radius:10px;padding:12px 15px;}
.principle{font-size:9pt;color:var(--muted);font-style:italic;margin-top:9px;text-align:center;}
.brand{font-size:8pt;color:#9aa8a0;text-align:center;margin-top:8px;letter-spacing:.04em;}
"""

TPL = """<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>{css}</style></head>
<body><div class="page"><div class="topbar"></div>
<div class="eyebrow">Персональный портрет · Внедрение ИИ</div>
<div class="name">{name}</div>
<div class="role">{role} · {dept}</div>
<div class="rule"></div>
<div class="lead">{lead}</div>
<div class="anchor">На что приятно опереться: <b>{anchor}</b>.</div>
<div class="sections">
  <div class="sec"><div class="chip">🎯</div><div class="body"><h3>Где ИИ будет вам особенно кстати</h3><p>{scenarios}</p></div></div>
  <div class="sec"><div class="chip">📚</div><div class="body"><h3>Как вам будет комфортнее осваивать</h3><p>{learning}</p></div></div>
  <div class="sec"><div class="chip">🌱</div><div class="body"><h3>Чтобы ИИ стал естественным, а не обязанностью</h3><p>{natural}</p></div></div>
  <div class="sec"><div class="chip">✨</div><div class="body"><h3>На чём стоит мягко сосредоточиться</h3><p>{focus}</p></div></div>
</div>
<div class="footer"><div class="thanks">{thanks}</div>
<div class="principle">«{principle}»</div>
<div class="brand">С благодарностью за ваше время и вдумчивые ответы</div></div>
</div></body></html>"""

THANKS = ("Спасибо, что уделили время опросу и отвечали вдумчиво и искренне. "
          "Этот портрет — не оценка, а дружеский взгляд со стороны и небольшая карта, "
          "как сделать работу с ИИ удобной именно для вас. Мы рядом и поможем на каждом шаге.")
DEFAULT_PRINCIPLE = "Не заменяет, а усиливает. ИИ — топливо, твой мозг — машина"


def find_chrome():
    for p in [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"]:
        if os.path.exists(p):
            return p
    return shutil.which("chrome") or shutil.which("msedge")


def esc(s):
    return html.escape(str(s), quote=False)


# Портрет обязан помещаться на один лист А4: он уходит человеку в личку как
# открытка, а не как документ. Второй лист = текст переписан слишком длинно.
WORD_LIMIT = 260


def word_count(p):
    return sum(len(str(p.get(k, "")).split()) for k in
               ("lead", "anchor", "scenarios", "learning", "natural", "focus"))


REQUIRED = ("id", "name", "role", "dept", "lead", "anchor", "scenarios", "learning", "natural", "focus")


def check_input(items):
    """Понятная ошибка вместо трейсбека, если portraits.json собран не так."""
    if not isinstance(items, list) or not items:
        raise SystemExit("portraits.json должен быть непустым СПИСКОМ объектов [{...}, {...}]")
    problems = []
    for i, p in enumerate(items):
        if not isinstance(p, dict):
            problems.append(f"элемент {i}: это {type(p).__name__}, а нужен объект с полями {', '.join(REQUIRED)}")
            continue
        missing = [k for k in REQUIRED if not str(p.get(k, "")).strip()]
        if missing:
            problems.append(f"элемент {i} ({p.get('name', 'без имени')}): нет полей {missing}")
    if problems:
        raise SystemExit("portraits.json заполнен неверно:\n  " + "\n  ".join(problems))


def pdf_pages(path):
    """Число страниц в PDF без внешних зависимостей."""
    try:
        with open(path, "rb") as f:
            return len(re.findall(rb"/Type\s*/Page[^sC]", f.read()))
    except OSError:
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--portraits", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-pdf", action="store_true")
    a = ap.parse_args()
    # utf-8-sig: JSON, сохранённый из PowerShell/Notepad, приходит с BOM.
    items = json.load(open(a.portraits, encoding="utf-8-sig"))
    hdir = os.path.join(a.out, "html"); pdir = os.path.join(a.out, "pdf")
    os.makedirs(hdir, exist_ok=True); os.makedirs(pdir, exist_ok=True)

    check_input(items)
    long_ones = [(p["name"], word_count(p)) for p in items if word_count(p) > WORD_LIMIT]
    for name, n in long_ones:
        print(f"ВНИМАНИЕ: {name} — {n} слов (ориентир ≤{WORD_LIMIT}), портрет рискует уехать на второй лист")

    for p in items:
        fam = str(p["name"]).split()[-1]
        base = f"{int(p['id']):02d}_{fam}"
        doc = TPL.format(css=CSS, name=esc(p["name"]), role=esc(p["role"]), dept=esc(p["dept"]),
                         lead=esc(p["lead"]), anchor=esc(p["anchor"]), scenarios=esc(p["scenarios"]),
                         learning=esc(p["learning"]), natural=esc(p["natural"]), focus=esc(p["focus"]),
                         thanks=esc(THANKS), principle=esc(p.get("principle", DEFAULT_PRINCIPLE)))
        open(os.path.join(hdir, base + ".html"), "w", encoding="utf-8").write(doc)
    print(f"wrote {len(items)} html -> {hdir}")

    if a.no_pdf:
        return
    chrome = find_chrome()
    if not chrome:
        print("Chrome/Edge не найден: HTML записан, PDF пропущен. Установите Chrome "
              "или откройте HTML и напечатайте в PDF вручную.")
        return
    overflow = []
    only = {f"{int(p['id']):02d}_{str(p['name']).split()[-1]}" for p in items}
    for f in sorted(glob.glob(os.path.join(hdir, "*.html"))):
        base = os.path.splitext(os.path.basename(f))[0]
        if base not in only:      # чужие файлы в папке не переверстываем
            continue
        dest = os.path.join(pdir, base + ".pdf")
        subprocess.run([chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
                        f"--print-to-pdf={dest}", f],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pages = pdf_pages(dest)
        if pages != 1:
            overflow.append((base, pages))
    print(f"wrote pdf -> {pdir}")
    if overflow:
        print("\nОШИБКА: портрет обязан быть на одном листе А4, а получилось:")
        for base, pages in overflow:
            print(f"  {base}.pdf — {pages} стр.")
        print("Сократите текст в portraits.json (ориентир ~200–260 слов на все блоки) и перезапустите.")
        raise SystemExit(2)


if __name__ == "__main__":
    main()
