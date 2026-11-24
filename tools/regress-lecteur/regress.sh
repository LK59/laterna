#!/usr/bin/env bash
# Banc anti-régression du lecteur en vrais navigateurs — voir README.md à côté.
#
#   regress.sh run <ref> <dossier de résultats>   construit, lance, joue, recueille, nettoie
#   regress.sh compare <résultats A> <résultats B> diff des lignes normalisées, sortie ≠ 0 si écart
#   regress.sh stabilite <ref> <dossier> [référence]  banc de stabilité : réseau bridé, rafales de
#                                                  sauts, reprises ; rapport et verdict (README)
#
# Étapes séparées, pour itérer :
#   regress.sh build <ref> | start <ref> | play <ref> <dossier> | stop <ref> | clean <ref>
#
# Variables : REGRESS_WORK (dossier de travail jetable, défaut $TMPDIR/regress-lecteur),
# REGRESS_ENV (.env de l'instance), REGRESS_DB (cine.db à recopier), REGRESS_MEDIA (bibliothèque,
# montée en lecture seule), REGRESS_CREDS (fichier user=/password= du compte de test),
# REGRESS_PORT (127.0.0.1 seulement, défaut 3098), REGRESS_NETWORK (défaut media_net),
# REGRESS_PROFILES (défaut « chromium firefox webkit iphone »), REGRESS_ONLY (clés de titres),
# REGRESS_MODE=rapide|moyen|complet (README, « Trois niveaux »), REGRESS_TITLES (titres.json).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${REGRESS_WORK:-${TMPDIR:-/tmp}/regress-lecteur}"
ENV_FILE="${REGRESS_ENV:-$REPO/.env}"
PROD_DB="${REGRESS_DB:-$REPO/data/cine.db}"
MEDIA="${REGRESS_MEDIA:-/mnt/media/video}"
CREDS="${REGRESS_CREDS:-}"
PORT="${REGRESS_PORT:-3098}"
NETWORK="${REGRESS_NETWORK:-media_net}"
PW_IMAGE="${REGRESS_PW_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
PW_VERSION="${REGRESS_PW_VERSION:-1.63.0}"
# Trois niveaux (README, « Trois niveaux »). REGRESS_PROFILES / REGRESS_ONLY, s'ils sont posés,
# l'emportent sur `rapide` ; REGRESS_PLAN (`profil/titre`, virgules) sur les trois.
# - rapide : deux profils, quatre titres — interface seule, ou dépendance prouvée par son propre banc ;
# - moyen : les quatre profils, chacun sur ce qu'il est seul à éprouver — retouche ciblée du lecteur ;
# - complet : tout, moins les séances dont l'issue ne dépend pas du navigateur (Des gens bien, refus
#   MP2 nommé : le même relais partout sauf l'iPhone, qui le prend en HLS natif) ou qui ne montrent
#   jamais d'image dans les passages de référence (Blanche comme neige sur WebKit bureau : 60 s
#   d'attente à chaque fois ; gardée sur l'iPhone) — découpe ou refonte du lecteur.
case "${REGRESS_MODE:-complet}" in
  rapide)
    REGRESS_PROFILES="${REGRESS_PROFILES:-chromium iphone}"
    REGRESS_ONLY="${REGRESS_ONLY:-kissing-booth,arthur,aftersun,the-knick}"
    ;;
  moyen)
    REGRESS_PLAN="${REGRESS_PLAN:-chromium/kissing-booth,chromium/arthur,chromium/the-knick,chromium/des-gens-bien,firefox/braveheart,firefox/arthur,firefox/aftersun,webkit/exorciste,webkit/dirty-dancing,webkit/the-knick,iphone/braveheart,iphone/aftersun,iphone/the-knick,iphone/des-gens-bien}"
    ;;
  complet)
    if [ -z "${REGRESS_PLAN:-}" ] && [ -z "${REGRESS_PROFILES:-}" ] && [ -z "${REGRESS_ONLY:-}" ]; then
      plan=""
      for p in chromium firefox webkit iphone; do
        for t in exorciste dirty-dancing braveheart blanche-neige arthur aftersun kissing-booth the-knick des-gens-bien; do
          case "$p/$t" in firefox/des-gens-bien|webkit/des-gens-bien|webkit/blanche-neige) continue ;; esac
          plan="$plan${plan:+,}$p/$t"
        done
      done
      REGRESS_PLAN="$plan"
    fi
    ;;
  *) echo "REGRESS_MODE inconnu : $REGRESS_MODE (rapide, moyen, complet)" >&2; exit 2 ;;
esac

# Le nom du conteneur et de l'image se lisent dans `docker ps` : une instance oubliée se retrouve.
slug() { git -C "$REPO" rev-parse --short=8 "$1^{commit}"; }
image_of() { echo "cine-app:regress-$1"; }
container_of() { echo "cine-regress-$1"; }

# Les fichiers écrits par l'application (1001) ne sont pas tous effaçables par l'utilisateur : un
# conteneur jetable les retire.
wipe_data() {
  local sha="$1"
  if [ -d "$WORK/data-$sha" ]; then
    docker run --rm --name "cine-regress-rm-$sha" -v "$WORK:/w" alpine:3.22 rm -rf "/w/data-$sha"
  fi
}

build() {
  local sha; sha="$(slug "$1")"
  local src="$WORK/src-$sha"
  rm -rf "$src"; mkdir -p "$src"
  # L'arbre du commit, et lui seul : ni la copie de travail, ni `data/`, ni `.env`.
  git -C "$REPO" archive "$sha" | tar -x -C "$src"
  docker build -q --build-arg BUILD_REF="$sha" -t "$(image_of "$sha")" "$src" >/dev/null
  rm -rf "$src"
  echo "image $(image_of "$sha")"
}

start() {
  local sha; sha="$(slug "$1")"
  local data="$WORK/data-$sha"
  [ -f "$ENV_FILE" ] || { echo "pas de fichier d'environnement : $ENV_FILE" >&2; exit 2; }
  stop "$1"
  wipe_data "$sha"; mkdir -p "$data"
  python3 -I "$HERE/prepare-data.py" "$PROD_DB" "$data"
  # L'application tourne en 1001:1000 comme en production (accès aux dossiers de la bibliothèque) :
  # le dossier doit lui être inscriptible.
  chmod -R g+rwX "$data"; chmod g+s "$data" "$data/logs"
  # CINE_BACKGROUND_JOBS=off (DECISIONS.md §145) : l'instance ne lance aucune tâche de fond — elle parle aux vrais
  # services avec une base recopiée qui n'a pas tout. Les neutralisations qui suivent datent d'avant cet
  # interrupteur ; elles restent, pour une image d'un commit plus ancien que lui, qui l'ignorerait.
  # REQUEST_HIDE_ACCOUNT vidé : le masquage des demandes écrit dans le vrai Jellyfin toutes les cinq minutes.
  # Avec la base recopiée, sans ses décisions, l'instance « rendait » au compte visé tout ce que la production
  # lui masque — et la production le remasquait au passage suivant (10/11/2026, sept heures durant).
  # XRAY_ENABLED=off (et ses réglages écartés de la base, `prepare-data.py`) : le planificateur de la bibliothèque
  # n'envoie pas d'ordres au vrai service depuis une instance de banc.
  docker run -d --name "$(container_of "$sha")" \
    --env-file "$ENV_FILE" \
    -e COOKIE_SECURE=false -e TZ=Europe/Paris \
    -e REPLIQUES_ENABLED=false -e REPLIQUES_NIGHTLY=false -e NEW_ACCOUNT_BLOCKED_TAGS= \
    -e CINE_BACKGROUND_JOBS=off -e REQUEST_HIDE_ACCOUNT= -e XRAY_ENABLED=off \
    -v "$MEDIA:$MEDIA:ro" -v "$data:/app/data" \
    --user 1001:1000 --network "$NETWORK" -p "127.0.0.1:$PORT:3000" \
    --memory 2g --security-opt no-new-privileges:true --cap-drop ALL \
    "$(image_of "$sha")" >/dev/null
  # Prête quand le catalogue répond (il est préchauffé au démarrage).
  for _ in $(seq 1 90); do
    if curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/ping"; then
      sleep 20  # le préchauffage du catalogue (selfWarm, catalogueWarm) avant la première ouverture
      echo "instance $(container_of "$sha") prête sur 127.0.0.1:$PORT"; return 0
    fi
    sleep 2
  done
  echo "l'instance ne répond pas" >&2; docker logs --tail 30 "$(container_of "$sha")" >&2; exit 1
}

play() {
  local sha; sha="$(slug "$1")"
  local out="$2"
  local data="$WORK/data-$sha"
  [ -n "$CREDS" ] && [ -f "$CREDS" ] || { echo "REGRESS_CREDS : fichier user=/password= du compte de test" >&2; exit 2; }
  mkdir -p "$out" "$WORK/pw"
  out="$(cd "$out" && pwd)"
  # Les dépendances de Playwright, installées une fois dans le dossier de travail.
  if [ ! -d "$WORK/pw/node_modules/playwright" ]; then
    docker run --rm --name "cine-regress-npm-$sha" -v "$WORK/pw:/w" -w /w "$PW_IMAGE" \
      sh -c "npm init -y >/dev/null && npm i --no-audit --no-fund playwright@$PW_VERSION >/dev/null"
  fi
  # `--network host` + localhost : un contexte sécurisé, sans lequel ni AudioEncoder ni OPFS n'existent.
  docker run --rm --name "cine-regress-pw-$sha" --network host --ipc host \
    -v "$WORK/pw/node_modules:/w/node_modules:ro" \
    -v "$HERE:/tool:ro" -v "$CREDS:/creds.txt:ro" -v "$data/logs:/logs:ro" -v "$out:/out" \
    -e BASE="http://localhost:$PORT" -e PROFILES="${REGRESS_PROFILES:-chromium firefox webkit iphone}" \
    -e TITLES="/tool/${REGRESS_TITLES:-titres.json}" -e ONLY="${REGRESS_ONLY:-}" -e PLAN="${REGRESS_PLAN:-}" -e ENDURANCE_MIN="${REGRESS_ENDURANCE_MIN:-}" \
    -e STAB="${REGRESS_STAB:-}" \
    -w /w "$PW_IMAGE" sh -c "cp /tool/scenario.mjs /w/ && node /w/scenario.mjs"
  python3 -I "$HERE/normalise.py" "$out"
}

stop() {
  local sha; sha="$(slug "$1")"
  local name; name="$(container_of "$sha")"
  if [ -n "$(docker ps -aq -f "name=^${name}\$")" ]; then
    docker rm -f "$name" >/dev/null && echo "instance $name retirée"
  fi
}

clean() {
  local sha; sha="$(slug "$1")"
  stop "$1"
  wipe_data "$sha"
  if docker image inspect "$(image_of "$sha")" >/dev/null 2>&1; then
    docker rmi "$(image_of "$sha")" >/dev/null && echo "image $(image_of "$sha") retirée"
  fi
}

# --- Banc de stabilité (README, « Banc de stabilité ») -------------------------------------------
# Le lien entre l'instance et le navigateur est bridé par `tc netem`, posé depuis un conteneur jetable qui
# partage l'espace réseau de l'instance (NET_ADMIN pour lui seul ; l'instance garde `--cap-drop ALL`).
# Seul le trafic vers la passerelle du réseau Docker est touché — c'est par elle qu'arrive le port publié,
# donc le navigateur ; Jellyfin et les autres services restent joints à pleine vitesse.
NET_IMAGE="cine-regress-tc:1"
net_image() {
  docker image inspect "$NET_IMAGE" >/dev/null 2>&1 && return 0
  printf 'FROM alpine:3.22\nRUN apk add --no-cache iproute2\n' | docker build -q -t "$NET_IMAGE" - >/dev/null
}
# net_set <ref> <arguments netem | off>
net_set() {
  local sha; sha="$(slug "$1")"; shift
  local gw; gw="$(docker network inspect "$NETWORK" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
  docker run --rm --name "cine-regress-tc-$sha-$RANDOM" --net "container:$(container_of "$sha")" --cap-add NET_ADMIN "$NET_IMAGE" sh -c "
    if [ \"\$1\" = off ]; then tc qdisc del dev eth0 root 2>/dev/null; exit 0; fi
    if tc qdisc show dev eth0 | grep -q 'netem 30:'; then tc qdisc change dev eth0 parent 1:3 handle 30: netem \$*
    else tc qdisc add dev eth0 root handle 1: prio && tc qdisc add dev eth0 parent 1:3 handle 30: netem \$* &&
      tc filter add dev eth0 parent 1:0 protocol ip prio 1 u32 match ip dst $gw/32 flowid 1:3; fi" sh "$@"
}
# Le lien instable, en boucle tant que le fichier témoin existe : 25 s correctes, 12 s très lentes,
# 3 s de coupure — le profil du Drive du 24/11/2026 (débit qui s'effondre puis revient).
net_unstable_loop() {
  local ref="$1" flag="$2"
  while [ -f "$flag" ]; do
    net_set "$ref" delay 40ms 10ms rate 30mbit; sleep 25; [ -f "$flag" ] || break
    net_set "$ref" delay 250ms 60ms loss 2% rate 2mbit; sleep 12; [ -f "$flag" ] || break
    net_set "$ref" loss 100%; sleep 3
  done
}
# Les phases : nom, genre de parcours (scenario.mjs, STAB), bridage, plan.
STAB_PHASES=(
  "reseau-lent|reseau|delay 120ms 30ms loss 0.3% rate 8mbit|chromium/kissing-booth,firefox/exorciste,iphone/aftersun"
  "reseau-instable|reseau|instable|chromium/kissing-booth,firefox/arthur,iphone/aftersun"
  "rafale|rafale|off|chromium/kissing-booth,firefox/braveheart,iphone/arthur"
  "reprise|reprise|delay 80ms 20ms rate 15mbit|chromium/kissing-booth,firefox/braveheart,iphone/arthur"
)
stabilite() {
  local ref="$1" out="$2" baseline="${3:-}"
  mkdir -p "$out"; out="$(cd "$out" && pwd)"
  net_image
  local flag="$WORK/net-instable-$(slug "$ref")"
  for entry in "${STAB_PHASES[@]}"; do
    IFS='|' read -r name kind shaping plan <<<"$entry"
    if [ -n "${REGRESS_PHASES:-}" ] && ! [[ ",$REGRESS_PHASES," == *",$name,"* ]]; then continue; fi
    echo "== phase $name ($shaping)"
    net_set "$ref" off
    local loop=""
    if [ "$shaping" = instable ]; then
      touch "$flag"; net_unstable_loop "$ref" "$flag" & loop=$!
    elif [ "$shaping" != off ]; then
      # shellcheck disable=SC2086
      net_set "$ref" $shaping
    fi
    REGRESS_STAB="$kind" REGRESS_PLAN="$plan" play "$ref" "$out/$name" || echo "phase $name : le parcours a échoué" >&2
    if [ -n "$loop" ]; then rm -f "$flag"; kill "$loop" 2>/dev/null || true; wait "$loop" 2>/dev/null || true; fi
    net_set "$ref" off
  done
  python3 -I "$HERE/stabilite-rapport.py" "$out" ${baseline:+"$baseline"}
}

case "${1:-}" in
  build) build "$2" ;;
  start) start "$2" ;;
  play) play "$2" "$3" ;;
  stop) stop "$2" ;;
  clean) clean "$2" ;;
  run)
    # La référence gardée à part : le piège s'exécute là où la sortie a lieu, souvent dans une
    # fonction dont `$2` est autre chose.
    REF="$2"
    trap 'clean "$REF"' EXIT
    t0=$(date +%s)
    build "$2"; start "$2"; play "$2" "$3"
    echo "durée : $(( $(date +%s) - t0 )) s"
    ;;
  compare) python3 -I "$HERE/compare.py" "$2" "$3" ;;
  stabilite)
    REF="$2"
    trap 'rm -f "$WORK/net-instable-$(slug "$REF")"; clean "$REF"' EXIT
    t0=$(date +%s)
    build "$2"; start "$2"
    rc=0; stabilite "$2" "$3" "${4:-}" || rc=$?
    echo "durée : $(( $(date +%s) - t0 )) s"
    exit "$rc"
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
