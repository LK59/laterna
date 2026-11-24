#!/usr/bin/env python3
"""Le rapport du banc de stabilité (`regress.sh stabilite`, README « Banc de stabilité »).

    stabilite-rapport.py <dossier du passage> [dossier d'un passage de référence]

Lit `<phase>/brut.json` de chaque phase, en tire par séance ce qui dit la stabilité (issues des
étapes, lignes `error` / `fallback` / `rebuild` / `stall`, durée des sauts, attentes, retombée des
rafales, temps et justesse des reprises), juge par des seuils, et compare à la référence si elle est
donnée. Écrit `rapport.md` dans le dossier du passage et l'affiche. Sortie 1 si une séance échoue.

Les seuils sont écrits ici, chacun avec sa raison. Ce qui « échoue » est ce qu'un spectateur ne
supporterait pas (le film ne repart pas, une erreur, une reprise au mauvais endroit, un relais au
lecteur serveur que rien n'explique) ; ce qui est « à regarder » est un écart de temps, ou un signe
(erreur JavaScript de la page, blocage) qu'une machine chargée peut aussi produire.
"""
import json
import statistics
import sys
from pathlib import Path

PHASES = ["reseau-lent", "reseau-instable", "rafale", "reprise"]
PHASE_LABEL = {
    "reseau-lent": "Réseau lent (8 Mb/s, 120 ms, 0,3 % de pertes)",
    "reseau-instable": "Réseau instable (25 s à 30 Mb/s, 12 s à 2 Mb/s, 3 s de coupure, en boucle)",
    "rafale": "Sauts en rafale (réseau local)",
    "reprise": "Reprises au milieu du film (15 Mb/s, 80 ms, cache des films vidé)",
}
# Issues d'étape qui disent qu'un spectateur serait resté bloqué.
FAILED_OUTCOMES = {"exception", "session perdue", "bouton absent", "échec", "bloquée", "mauvaise position", "délai dépassé", "retour à l'écran de connexion"}
# Un relais au lecteur serveur que le lien explique est un choix du lecteur (§77/§78), pas une panne.
SLOW_LINK_HINTS = ("connexion trop lente", "lien lent", "allégée")
# Seuils « à regarder » (absolus) — par phase quand la phase change ce qui est raisonnable.
RAFALE_RETOMBEE_MS = 15000  # en local, un film qui met plus de 15 s à repartir après une série
REPRISE_MS = 10000  # mesure du lecteur, à 15 Mb/s : au-delà, anormal (médiane iPhone depuis le réseau : 3,1 s)
SEEK_MAX_MS = {"reseau-lent": 30000, "reseau-instable": 45000, "rafale": 15000, "reprise": 15000}
# Comparaison avec la référence : plus lent si au-delà de ×1,5 et de 2 s de plus.
SLOWER_RATIO, SLOWER_ABS_MS = 1.5, 2000


def parse(lines):
    out = []
    for t in lines or []:
        try:
            out.append(json.loads(t) if isinstance(t, str) else t)
        except ValueError:
            pass
    return out


def median(values):
    return round(statistics.median(values)) if values else None


def metrics(case, phase):
    lines = parse(case.get("playerLines"))
    server = parse(case.get("serverLines"))
    kinds = lambda k: [l for l in lines if l.get("kind") == k]  # noqa: E731
    seeks = [l["tookMs"] for l in kinds("seek") if isinstance(l.get("tookMs"), (int, float))]
    stops = {}
    for l in kinds("stop"):
        stops[l.get("session")] = l
    openings = [l["firstMoveMs"] for l in kinds("opening") if isinstance(l.get("firstMoveMs"), (int, float))]
    # La mesure du lecteur par séance : de son ouverture à l'horloge qui bouge (sans le code de l'app).
    move_of = {l.get("session"): l.get("firstMoveMs") for l in kinds("opening")}
    steps = case.get("steps", [])
    m = {
        "steps": steps,
        "errors": [(l.get("reason") or l.get("message") or "")[:140] for l in kinds("error")],
        "fallbacks": [(l.get("reason") or "")[:140] for l in kinds("fallback")],
        "rebuilds": len(kinds("rebuild")),
        "stalls": len(kinds("stall")),
        "network": len(kinds("network")),
        "seekCount": len(seeks),
        "seekMed": median(seeks),
        "seekMax": max(seeks) if seeks else None,
        "firstImage": openings[0] if openings else None,
        "waits": sum(int(s.get("waits") or 0) for s in stops.values()),
        "waitedMs": sum(int(s.get("waitedMs") or 0) for s in stops.values()),
        "slowLink": any(s.get("slowLink") for s in stops.values()),
        "openedFrom": [l.get("openedFrom") for l in kinds("start") if l.get("openedFrom")],
        "pageErrors": case.get("consoleErrors") or [],
        "serverErrors": [(l.get("message") or "")[:140] for l in server if l.get("level") == "error"],
        "retombee": {s["step"]: s["retombeeMs"] for s in steps if "retombeeMs" in s},
        "reprises": {
            s["step"]: {"ms": s.get("ms"), "ecart": s.get("ecart"), "player": move_of.get(s.get("session"))}
            for s in steps
            if s["step"].startswith("reprise ")
        },
    }
    return m


def judge(m, phase):
    fails, warns = [], []
    for s in m["steps"]:
        if s.get("outcome") in FAILED_OUTCOMES:
            fails.append(f"{s['step']} : {s['outcome']}")
    for e in m["errors"]:
        fails.append(f"erreur : {e}")
    for f in m["fallbacks"]:
        (warns if any(h in f for h in SLOW_LINK_HINTS) else fails).append(f"relais : {f or 'sans motif'}")
    if m["seekMax"] is not None and m["seekMax"] > SEEK_MAX_MS[phase]:
        warns.append(f"saut le plus long {m['seekMax'] / 1000:.1f} s (seuil {SEEK_MAX_MS[phase] / 1000:.0f} s)")
    for name, ms in m["retombee"].items():
        if ms > RAFALE_RETOMBEE_MS:
            warns.append(f"{name} : repart en {ms / 1000:.1f} s")
    for name, r in m["reprises"].items():
        if r["player"] and r["player"] > REPRISE_MS:
            warns.append(f"{name} : première image en {r['player'] / 1000:.1f} s (mesure du lecteur)")
    if phase in ("rafale", "reprise") and m["stalls"]:
        warns.append(f"{m['stalls']} blocage(s) de 5 s sur réseau correct")
    for e in m["pageErrors"]:
        warns.append(f"erreur de la page : {e}")
    for e in m["serverErrors"]:
        warns.append(f"erreur serveur : {e}")
    return fails, warns


def compare(m, ref):
    """Ce qui est nettement plus lent que la référence (même phase, même séance)."""
    out = []

    def slower(label, now, before):
        if now is None or before is None:
            return
        if now > before * SLOWER_RATIO and now - before > SLOWER_ABS_MS:
            out.append(f"{label} {before / 1000:.1f} → {now / 1000:.1f} s")

    slower("première image", m["firstImage"], ref["firstImage"])
    slower("saut médian", m["seekMed"], ref["seekMed"])
    slower("saut le plus long", m["seekMax"], ref["seekMax"])
    slower("attente totale", m["waitedMs"], ref["waitedMs"])
    for name, ms in m["retombee"].items():
        slower(name, ms, ref["retombee"].get(name))
    for name, r in m["reprises"].items():
        slower(name, r["player"], (ref["reprises"].get(name) or {}).get("player"))
    if m["rebuilds"] > ref["rebuilds"] + 1:
        out.append(f"reconstructions {ref['rebuilds']} → {m['rebuilds']}")
    if m["stalls"] > ref["stalls"] + 1:
        out.append(f"blocages {ref['stalls']} → {m['stalls']}")
    return out


def load(folder):
    cases = {}
    for phase in PHASES:
        brut = Path(folder) / phase / "brut.json"
        if not brut.exists():
            continue
        for case in json.loads(brut.read_text("utf-8")):
            cases[(phase, f"{case['profile']}/{case['key']}")] = metrics(case, phase)
    return cases


def sec(ms):
    return "—" if ms is None else f"{ms / 1000:.1f} s"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    folder = Path(sys.argv[1])
    ref = load(sys.argv[2]) if len(sys.argv) > 2 else {}
    cases = load(folder)
    rows, details, failed, warned = [], [], 0, 0
    for (phase, name), m in sorted(cases.items(), key=lambda kv: (PHASES.index(kv[0][0]), kv[0][1])):
        fails, warns = judge(m, phase)
        if (phase, name) in ref:
            warns += [f"plus lent que la référence : {c}" for c in compare(m, ref[(phase, name)])]
        verdict = "ÉCHEC" if fails else "à regarder" if warns else "ok"
        failed += bool(fails)
        warned += bool(warns) and not fails
        extra = ""
        if m["retombee"]:
            extra = "retombée " + " / ".join(sec(v) for v in m["retombee"].values())
        if m["reprises"]:
            # La mesure du lecteur (son ouverture → l'horloge qui bouge). L'appui → l'image, dans brut.json,
            # compte aussi l'attente de Playwright sur l'animation de la fiche et le premier chargement du code
            # du lecteur dans ce navigateur (relevé du 24/11/2026) : rien qui dise la vitesse de la reprise.
            extra = " · ".join(f"{k[8:]} {sec(v['player'])} (écart {v['ecart']} s)" for k, v in m["reprises"].items())
        rows.append(
            f"| {phase} | {name} | **{verdict}** | {sec(m['firstImage'])} | {m['seekCount']} : {sec(m['seekMed'])} / {sec(m['seekMax'])} "
            f"| {m['waits']} ({sec(m['waitedMs'])}) | {m['rebuilds']} / {m['stalls']} | {','.join(sorted(set(m['openedFrom']))) or '—'} | {extra} |"
        )
        if fails or warns:
            details.append(f"- **{phase} · {name}** — " + " ; ".join(fails + warns))
    total = len(cases)
    head = [
        "# Banc de stabilité du lecteur",
        "",
        f"Passage : `{folder.name}`" + (f" — comparé à `{Path(sys.argv[2]).name}`" if ref else " — sans référence"),
        "",
        f"**{total - failed - warned} ok · {warned} à regarder · {failed} en échec** sur {total} séances.",
        "",
        "Phases : " + " ; ".join(PHASE_LABEL[p] for p in PHASES if any(k[0] == p for k in cases)) + ".",
        "",
        "| Phase | Séance | Verdict | 1re image | Sauts : médian / max | Attentes | Reconstr. / blocages | Ouvert depuis | Rafales / reprises |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    text = "\n".join(head + rows + ([""] + ["## Points relevés", ""] + details if details else []) + [""])
    (folder / "rapport.md").write_text(text, "utf-8")
    print(text)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
