#!/bin/sh
# GitSync safe deploy: project-specific settings remain in tools/ih.conf.
# No automatic commit, push, reset, clean or destructive rollback.
set -eu
[ "$#" -eq 3 ] || { echo "usage: deploy.sh PROJECT REMOTE BRANCH" >&2; exit 2; }
PROJECT=$1 REMOTE=$2 BRANCH=$3
cd "$PROJECT"
. tools/ih.conf
exec 9>.git/ih-op.lock
flock -n 9 || { echo "GitSync: другая операция выполняется" >&2; exit 1; }
log() { printf '%s: %s\n' "$(date '+%d.%m.%Y %H:%M')" "$*" | tee .git/ih-last-op; }
case "$REMOTE" in *[!a-zA-Z0-9_.-]*|'') log "Недопустимый remote"; exit 1;; esac
case "$BRANCH" in *[!a-zA-Z0-9_./-]*|'') log "Недопустимая ветка"; exit 1;; esac
# Fetch and verify before stopping the service.
git fetch -q "$REMOTE" "$BRANCH" || { log "Ошибка fetch"; exit 1; }
target=$(git rev-parse --verify "refs/remotes/$REMOTE/$BRANCH^{commit}") || exit 1
git merge-base --is-ancestor HEAD "$target" || { log "Истории разошлись: требуется ручное разрешение"; exit 1; }
if [ "$(git rev-parse HEAD)" = "$target" ]; then log "Обновлений нет"; exit 0; fi
# Refuse untracked/modified files that incoming commits would replace.
incoming=$(mktemp)
localfiles=$(mktemp)
trap 'rm -f "$incoming" "$localfiles"' EXIT
# Compare pathnames using newline lists (project paths are normal UTF-8 file names).
git diff --name-only HEAD "$target" | sort -u > "$incoming"
{ git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | sort -u > "$localfiles"
if comm -12 "$incoming" "$localfiles" | grep -q .; then
  log "Локальные изменения пересекаются с обновлением; развертывание отменено"
  exit 1
fi
# Check project policy before touching the running system.
python3 tools/ihsecrets.py check >/dev/null || { log "Проверка секретов не прошла"; exit 1; }
stopped=0
restart() {
  code=$?
  trap - EXIT
  rm -f "$incoming" "$localfiles"
  if [ "$stopped" -eq 1 ]; then
    if sh -c "$IH_START"; then :; else log "КРИТИЧНО: intraHouse не удалось запустить"; exit 1; fi
  fi
  if [ "$code" -ne 0 ]; then log "Deploy завершился с ошибкой; автоматический откат не выполнялся"; fi
  exit "$code"
}
trap restart EXIT
sh -c "$IH_STOP"
stopped=1
# Snapshot while databases are stopped; archive may include secrets, mode 0600.
mkdir -p "$IH_SNAPSHOTS"
chmod 700 "$IH_SNAPSHOTS"
snap="$IH_SNAPSHOTS/lav24-$(date +%Y%m%d-%H%M%S)-before-deploy.tar.gz"
(umask 077; tar --exclude=./.git -czf "$snap" .)
chmod 600 "$snap"
# Revalidate before applying changes. No commit or push is performed.
git merge --ff-only "$target"
log "Обновлено до $(git rev-parse --short HEAD); снимок $(basename "$snap")"
