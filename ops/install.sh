#!/bin/sh
set -eu
umask 077
ops=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "${1:?Укажите каталог проекта}"
state=$(git rev-parse --absolute-git-dir)
[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ]
case "$ops" in *"'"*) echo "Путь к плагину содержит апостроф" >&2; exit 1 ;; esac
config="$state/gitsync"
mkdir -p -- "$config"
chmod 700 "$config"
exec 9>"$state/ih-op.lock"
flock -n 9
if [ ! -f "$config/ihsecrets.json" ]; then
  install -m 600 "${2:-tools/ihsecrets.json}" "$config/ihsecrets.json"
fi
if [ ! -f "$config/ih.conf" ]; then
  install -m 600 "${3:-tools/ih.conf}" "$config/ih.conf"
fi
python3 "$ops/ihsecrets.py" names >/dev/null
hook="$state/hooks/pre-commit"
active_hooks=$(git config --get core.hooksPath || true)
if [ -z "$active_hooks" ]; then
  case "$(readlink "$hook" || true)" in
    ../../tools/pre-commit) rm -- "$hook" ;;
  esac
  if [ ! -e "$hook" ] && [ ! -L "$hook" ]; then
    mkdir -p -- "$(dirname -- "$hook")"
    cat > "$hook" <<HOOK
#!/bin/sh
exec /bin/sh '$ops/pre-commit.sh'
HOOK
    chmod 700 "$hook"
  fi
fi
git config --local filter.ihsecrets.clean "python3 '$ops/ihsecrets.py' clean %f"
git config --local filter.ihsecrets.smudge "python3 '$ops/ihsecrets.py' smudge %f"
git config --local filter.ihsecrets.required true
# Legacy private config remains ignored until removed manually after migration.
echo "Настройки gitsync: $config"
