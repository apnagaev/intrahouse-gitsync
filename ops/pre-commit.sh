#!/bin/sh
set -eu
ops=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
python3 "$ops/ihsecrets.py" check-staged
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --pre-commit --staged --no-banner --redact -c "$ops/gitleaks.toml" .
fi
