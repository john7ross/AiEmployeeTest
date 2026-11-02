# -*- coding: utf-8 -*-
"""Инструменты отдела в репозитории ai-tools: сколько их и кто авторы.

Смотрится ТОЛЬКО папка отдела (config.json → ai_tools_folder), папки других
отделов в метрики не входят.

Единица подсчёта — инструмент, а не файл: скилл целиком, скрипт-папка, архив MCP,
отдельный документ — по одному. index.md, README и images не считаются.

Автор берётся из колонки «Автор / поддерживает» в index.md каталогов, а не из
истории коммитов: чужие материалы заливают пакетом, и автор в git не виден.
"""
import os, re, subprocess
import survey_lib as L

SERVICE_FILES = {"index.md", "README.md", ".keep", ".gitkeep"}


def _git(repo, *args):
    return subprocess.run(["git", "-C", repo, "-c", "core.quotepath=false", *args],
                          capture_output=True, text=True, encoding="utf-8")


def settings():
    return (os.path.expanduser(L.CFG.get("ai_tools_repo", "~/it-architecture/ai-tools")),
            L.CFG.get("ai_tools_folder", "business-analysis"),
            L.CFG.get("ai_tools_branch", "origin/main"))


def fetch(repo):
    r = _git(repo, "fetch", "-q", "origin")
    return r.returncode == 0, r.stderr.strip()


def revision(repo, branch, asof=None):
    """Коммит ветки на дату (включительно) или её вершина."""
    if not asof:
        return branch
    r = _git(repo, "rev-list", "-1", f"--before={asof.isoformat()}T23:59:59", branch)
    return r.stdout.strip() or None


def files(repo, rev, folder):
    r = _git(repo, "ls-tree", "-r", "--name-only", rev, folder)
    return [l for l in r.stdout.splitlines() if l]


def units(repo, rev, folder):
    """[(вид, название)] — по одному на инструмент."""
    fs = files(repo, rev, folder)
    skill_dirs = {f.rsplit("/", 1)[0] for f in fs if f.endswith("/SKILL.md")}
    out, seen = [], set()
    for f in fs:
        parts = f.split("/")
        if parts[-1] in SERVICE_FILES or len(parts) < 3 or parts[1] == "images":
            continue
        sd = next((d for d in skill_dirs if f.startswith(d + "/")), None)
        if sd:
            key = ("скилл", sd.split("/")[-1])
        elif parts[1] == "skills":
            continue            # служебное рядом со скиллами (README группы)
        elif parts[1] == "scripts" and len(parts) > 3:
            key = ("скрипт", parts[2])
        else:
            key = (parts[1], "/".join(parts[2:]))
        if key not in seen:
            seen.add(key); out.append(key)
    return out


def authors(repo, rev, folder):
    """{название инструмента: [авторы]} из таблиц index.md всех каталогов папки."""
    out = {}
    for f in files(repo, rev, folder):
        if not f.endswith("/index.md"):
            continue
        text = _git(repo, "show", f"{rev}:{f}").stdout
        i_author = None
        for line in text.splitlines():
            if not line.startswith("|"):
                i_author = None if not line.strip() else i_author
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if any("Автор" in c for c in cells):
                i_author = next(i for i, c in enumerate(cells) if "Автор" in c)
                continue
            if i_author is None or set("".join(cells)) <= set("-: "):
                continue
            if i_author < len(cells):
                names = [n.strip() for n in re.split(r"[,;]", cells[i_author])]
                names = [n for n in names if n and n not in ("—", "-")]
                out[cells[0]] = names
    return out


def norm_name(s):
    """«Валерия Антошкина» и «Антошкина Валерия» — один человек."""
    return frozenset(str(s).lower().replace("ё", "е").split())
