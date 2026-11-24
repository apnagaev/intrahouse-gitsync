#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 4 ] && { [ "$#" -ne 5 ] || [ "$1" != deploy ] || [ "$5" != --check ]; }; then
  echo 'Usage: project.sh deploy|rollback|backup PROJECT REMOTE BRANCH [--check (deploy only)]' >&2
  exit 2
fi
op=$1
check_only=${5:-}
project=$2
remote=$3
branch=$4
ops=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$project"
state=$(git rev-parse --absolute-git-dir)
exec 9>"$state/ih-op.lock"
flock -n 9 || exit 1
say() {
  printf '%s: %s\n' "$(date '+%F %T')" "$*" > "$state/ih-last-op.tmp"
  mv -- "$state/ih-last-op.tmp" "$state/ih-last-op"
}
stopped=0
recovery=
head=
finish() {
  code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then
    say "Ошибка операции $op"
    if [ "$stopped" -eq 1 ]; then
      if [ -n "$recovery" ]; then
        if ! git reset --mixed "$head" >/dev/null || ! restore "$recovery"; then
          say "Ошибка восстановления. Служба остановлена. Снимок: $recovery"
          exit "$code"
        fi
      fi
      if ! sh -c "$IH_START"; then
        say "Не удалось запустить intraHouse. Снимок: ${recovery:-нет}"
      fi
    fi
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
. "$state/gitsync/ih.conf"
: "${IH_STOP:?}" "${IH_START:?}" "${IH_SNAPSHOTS:?}"
case "$IH_SNAPSHOTS" in /*) ;; *) exit 1 ;; esac
backup=$(realpath -m -- "$IH_SNAPSHOTS")
case "$backup/" in "$PWD/"*) exit 1 ;; esac
prefix="$(basename "$PWD")-gitsync-"
head=$(git rev-parse HEAD)
[ "$(git symbolic-ref --short HEAD)" = "$branch" ]

project_tar() {
  tar --exclude=./.git --exclude=./hist --exclude=./logdb --exclude=./operative "$@"
}

snapshot() {
  file=$(mktemp "$backup/.$prefix.XXXXXXXX")
  final="$backup/$prefix$(date -u '+%Y%m%d%H%M%S')-${file##*.}-$1.tar.gz"
  if ! project_tar -czf "$file" .; then
    rm -f -- "$file"
    return 1
  fi
  mv -- "$file" "$final" || return 1
  printf '%s\n' "$final"
}

restore() {
  find . -mindepth 1 -maxdepth 1 ! -name .git ! -name hist ! -name logdb ! -name operative -exec rm -rf -- {} + &&
    project_tar -xzf "$1"
}

live_file=./jbase/devparam.db
preserve_live=0
check_deploy_status() {
  changes=$(git status --porcelain --untracked-files=all)
  while IFS= read -r change; do
    case "$change" in
      '') ;;
      ' M jbase/devparam.db') [ "$preserve_live" -eq 1 ] || return 1 ;;
      ' M jbase/units.db')
        if ! git diff --quiet "$head" "$target" -- jbase/units.db; then
          echo 'units.db изменён и локально, и в целевом коммите' >&2
          return 1
        fi
        ;;
      *) printf 'Локальная правка блокирует deploy: %s\n' "$change" >&2; return 1 ;;
    esac
  done <<STATUS
$changes
STATUS
}

case "$op" in
  deploy)
    git fetch -- "$remote" "$branch"
    target=$(git rev-parse FETCH_HEAD)
    old_attrs=$(git show "$head:.gitattributes")
    new_attrs=$(git show "$target:.gitattributes")
    attrs() { printf '%s\n' "$1" | sed '/^#/d; /^[[:space:]]*$/d'; }
    [ "$(attrs "$old_attrs")" = "$(attrs "$new_attrs")" ]
    for file in jbase/globals.db jbase/units.db project.json; do
      [ "$(git check-attr filter -- "$file")" = "$file: filter: ihsecrets" ]
    done
    git merge-base --is-ancestor "$head" "$target"
    if git cat-file -e "$head:jbase/devparam.db" 2>/dev/null && ! git cat-file -e "$target:jbase/devparam.db" 2>/dev/null; then
      preserve_live=1
    fi
    check_deploy_status
    # Validate the exact incoming secret-bearing files before stopping the service.
    for file in jbase/globals.db jbase/units.db project.json; do
      git show "$target:$file" | python3 "$ops/ihsecrets.py" validate "$file"
    done
    ;;
  rollback)
    snap=$(cat "$state/gitsync/last-deploy")
    case "$snap" in "$backup/$prefix"*-before-deploy.tar.gz) ;; *) exit 1 ;; esac
    tar -tzf "$snap" >/dev/null
    ;;
  backup) ;;
  *) exit 1 ;;
esac

if [ "$op" = deploy ]; then
  # The installed filter must still be effective on the checkout.
  [ "$(git config --get filter.ihsecrets.required)" = true ]
  [ "$(git config --get filter.ihsecrets.clean)" = "python3 '$ops/ihsecrets.py' clean %f" ]
  [ "$(git config --get filter.ihsecrets.smudge)" = "python3 '$ops/ihsecrets.py' smudge %f" ]
fi
if [ "$check_only" = --check ]; then
  printf '%s\n' 'Предпроверка Deploy пройдена'
  exit 0
fi
mkdir -p -- "$backup"
chmod 700 "$backup"
say "Операция $op выполняется"
stopped=1
sh -c "$IH_STOP"
case "$op" in
  deploy)
    check_deploy_status
    snap=$(snapshot before-deploy)
    recovery=$snap
    if [ "$preserve_live" -eq 1 ]; then
      git restore -- "$live_file"
    fi
    git merge --ff-only "$target"
    if [ "$preserve_live" -eq 1 ]; then
      git check-ignore -q -- "$live_file"
      tar -xzf "$snap" -- "$live_file"
    fi
    python3 "$ops/ihsecrets.py" check
    ;;
  rollback)
    recovery=$(snapshot before-rollback)
    restore "$snap"
    ;;
  backup) snap=$(snapshot manual) ;;
esac
sh -c "$IH_START"
stopped=0
if [ "$op" = deploy ]; then
  printf '%s\n' "$snap" > "$state/gitsync/last-deploy.tmp"
  mv -- "$state/gitsync/last-deploy.tmp" "$state/gitsync/last-deploy"
fi
# Keep the rollback target even when newer manual snapshots fill the quota.
python3 - "$backup" "$prefix" "${IH_KEEP:-20}" "$state/gitsync/last-deploy" <<'PYCODE'
from pathlib import Path
import sys

directory, prefix, limit, pointer = sys.argv[1:]
limit = int(limit)
if limit < 1:
    raise ValueError("IH_KEEP must be positive")
pointer = Path(pointer)
protected = Path(pointer.read_text().strip()) if pointer.is_file() else None
snapshots = sorted(
    (p for p in Path(directory).iterdir() if p.name.startswith(prefix) and p.name.endswith(".tar.gz")),
    key=lambda p: p.stat().st_mtime_ns,
    reverse=True,
)
for snapshot in snapshots[limit:]:
    if snapshot != protected:
        snapshot.unlink()
PYCODE
say "Операция $op завершена. Снимок: $(basename "$snap")"
