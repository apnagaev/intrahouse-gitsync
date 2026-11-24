#!/usr/bin/env python3
"""Секреты проекта intraHouse вне git.

git-фильтр (подключается в .git/config, см. README.md):
  clean  <путь>   stdin → stdout: значения секретов → "${ИМЯ}"   (то, что уходит в git)
  smudge <путь>   stdin → stdout: "${ИМЯ}" → значение из .env  (то, что лежит на диске)

Служебные команды:
  extract [--force]   прочитать секреты из файлов проекта на диске и дописать их в .env
  check               найти значения из .env в том, что уйдёт в git (после clean)
  names               список имён секретов из ihsecrets.json

Правила — .git/gitsync/ihsecrets.json, значения — .env в корне проекта
(или файл из переменной окружения IHSECRETS_ENV). Без внешних зависимостей.
"""
import json
import os
import re
import subprocess
import sys

ROOT = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
GIT_DIR = subprocess.check_output(['git', 'rev-parse', '--absolute-git-dir'], text=True).strip()
with open(os.path.join(GIT_DIR, 'gitsync', 'ihsecrets.json'), encoding='utf8') as config:
    CONF = json.load(config)
ENV_PATH = os.environ.get('IHSECRETS_ENV') or os.path.join(ROOT, '.env')
PH = re.compile(r'"\$\{([A-Z0-9_]+)(:num)?\}"')


def die(msg):
    sys.stderr.write('ihsecrets: ' + msg + '\n')
    sys.exit(1)


# ---------------------------------------------------------------- .env
def load_env():
    env = {}
    if os.path.exists(ENV_PATH):
        for line in open(ENV_PATH, encoding='utf8'):
            line = line.rstrip('\n').rstrip('\r')
            if not line or line.lstrip().startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v
    return env


def save_env(env, order):
    lines = []
    if os.path.exists(ENV_PATH):
        lines = open(ENV_PATH, encoding='utf8').read().splitlines()
    have = {l.split('=', 1)[0].strip() for l in lines if '=' in l and not l.lstrip().startswith('#')}
    out = []
    for l in lines:
        k = l.split('=', 1)[0].strip() if '=' in l and not l.lstrip().startswith('#') else None
        out.append(k + '=' + env[k] if k in env else l)
    for k in order:
        if k not in have and k in env:
            out.append(k + '=' + env[k])
    fd = os.open(ENV_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf8') as f:
        f.write('\n'.join(out) + '\n')


# ---------------------------------------------------------------- правила
def env_name(s):
    return re.sub(r'[^A-Z0-9]+', '_', s.upper()).strip('_')


def rules_for(path):
    path = path.replace('\\', '/')
    for p, spec in CONF['files'].items():
        if path == p or path.endswith('/' + p):
            return spec
    return None


def secrets_in_obj(obj, spec):
    """[(поле, имя переменной, значение)] для одного объекта (строки nedb или json-файла)."""
    found = []
    if not isinstance(obj, dict):
        return found
    for r in spec.get('rules', []):
        m = r.get('match', {})
        if all(obj.get(k) == v for k, v in m.items()) and r['field'] in obj:
            found.append((r['field'], r['env'], obj[r['field']]))
    if 'auto_fields' in spec and '_id' in obj:
        names = {f for f, _, _ in found}
        for f in spec['auto_fields']:
            if f in obj and f not in names:
                found.append((f, env_name('UNIT_' + str(obj['_id']) + '_' + f), obj[f]))
    return [(f, n, v) for f, n, v in found
            if v not in ('', None) and not isinstance(v, (dict, list, bool))]


def literal(v):
    return json.dumps(v, ensure_ascii=False)


def replace_field(text, field, value, placeholder, where):
    pat = re.compile(r'("' + re.escape(field) + r'"\s*:\s*)' + re.escape(literal(value)))
    new, n = pat.subn(lambda m: m.group(1) + placeholder, text, count=1)
    if n != 1:
        die('не нашёл значение поля "%s" в %s — формат файла изменился, коммит остановлен' % (field, where))
    return new


def placeholder(name, value):
    return '"${%s%s}"' % (name, ':num' if isinstance(value, (int, float)) else '')


def iter_objs(text, spec):
    """(объект, начало, конец) для каждой строки nedb или один объект для json."""
    if spec['type'] == 'json':
        try:
            yield json.loads(text), 0, len(text)
        except ValueError:
            die('некорректный JSON')
        return
    pos = 0
    for line in text.splitlines(keepends=True):
        s = line.strip()
        if s:
            try:
                yield json.loads(s), pos, pos + len(line)
            except ValueError:
                die('некорректная строка NeDB')
        pos += len(line)


def clean(text, path, collect=None):
    spec = rules_for(path)
    if not spec:
        if path in ('jbase/globals.db', 'jbase/units.db', 'project.json'):
            die('нет правил для ' + path)
        return text
    out, last = [], 0
    for obj, a, b in iter_objs(text, spec):
        chunk = text[a:b]
        for field, name, value in secrets_in_obj(obj, spec):
            if isinstance(value, str) and PH.fullmatch('"' + value + '"'):
                continue  # уже заглушка
            chunk = replace_field(chunk, field, value, placeholder(name, value), path)
            if collect is not None:
                collect[name] = str(value)
        out.append(text[last:a])
        out.append(chunk)
        last = b
    out.append(text[last:])
    return ''.join(out)


def smudge(text, path, env=None):
    env = load_env() if env is None else env
    missing = set()

    def sub(m):
        name, num = m.group(1), m.group(2)
        value = env.get(name)
        if not value:
            missing.add(name)
            return m.group(0)
        if num and not re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?', value):
            die('ожидалось число для ' + name)
        return value if num else literal(value)
    text = PH.sub(sub, text)
    if missing:
        die('%s: нет значений в .env: %s' % (path, ', '.join(sorted(missing))))
    return text


# ---------------------------------------------------------------- команды
def read_stdin():
    return sys.stdin.buffer.read().decode('utf8')


def write_stdout(text):
    sys.stdout.buffer.write(text.encode('utf8'))


def cmd_extract(force):
    env = load_env()
    got, order = {}, []
    for p in CONF['files']:
        full = os.path.join(ROOT, p)
        if not os.path.exists(full):
            continue
        found = {}
        clean(open(full, encoding='utf8').read(), p, found)
        for k, v in found.items():
            order.append(k)
            if k not in env or force:
                got[k] = v
    env.update(got)
    save_env(env, order)
    print('записано в %s: %s' % (ENV_PATH, ', '.join(sorted(got)) or 'ничего нового'))


def tracked_files():
    try:
        out = subprocess.run(['git', '-C', ROOT, 'ls-files', '-co', '--exclude-standard'],
                             capture_output=True, text=True, check=True).stdout.split('\n')
        return [f for f in out if f]
    except Exception:
        res = []
        for d, dirs, files in os.walk(ROOT):
            dirs[:] = [x for x in dirs if x not in ('.git', 'private')]
            res += [os.path.relpath(os.path.join(d, f), ROOT) for f in files]
        return res


def string_values(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for key, value in obj.items():
            yield key
            yield from string_values(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from string_values(value)

def cmd_check():
    env = load_env()
    vals = {k: v for k, v in env.items() if len(v) >= 4 and not k.startswith('IH_')}
    bad = 0
    for f in tracked_files():
        full = os.path.join(ROOT, f)
        if f == '.env' or not os.path.isfile(full):
            continue
        try:
            text = open(full, encoding='utf8').read()
        except (UnicodeDecodeError, OSError):
            continue
        text = clean(text, f)

        if f.endswith(".db"):
            try:
                objects = [
                    json.loads(line)
                    for line in text.splitlines()
                    if line.strip()
                ]
            except json.JSONDecodeError:
                print("ОШИБКА JSON:", f)
                bad += 1
                continue

            values = [
                value
                for obj in objects
                for value in string_values(obj)
            ]
        else:
            values = [text]

        for k, v in vals.items():
            if any(v in value for value in values):
                print('УТЕЧКА: %s содержит значение %s' % (f, k))
                bad += 1
    print('проверено, утечек: %d' % bad)
    sys.exit(1 if bad else 0)


def validate(text, path):
    if not text or rules_for(path) is None or clean(text, path) != text:
        die('непроверенный или незамаскированный файл: ' + path)
    smudge(text, path)


def git_bytes(*args):
    return subprocess.check_output(['git', '-C', ROOT, *args])


def check_staged():
    if not os.path.isfile(ENV_PATH):
        die('нет локального .env')
    values = [v.encode('utf8') for v in load_env().values() if len(v) >= 4]
    files = git_bytes('diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z')
    for raw_path in files.split(b'\0'):
        if not raw_path:
            continue
        path = os.fsdecode(raw_path)
        if re.match(r'^(?:\.env(?:$|\.)|(?:private|bak|temp|logdb|db|operative|tools)/|jbase/(?:projects|zipprojects)\.db$)', path):
            die('запрещённый файл в индексе: ' + path)
        blob = git_bytes('show', ':' + path)
        if path in ('jbase/globals.db', 'jbase/units.db', 'project.json'):
            attr = git_bytes('check-attr', '--cached', 'filter', '--', path)
            required = git_bytes('config', '--get', 'filter.ihsecrets.required')
            if not attr.rstrip().endswith(b': ihsecrets') or required.strip() != b'true':
                die('не настроен обязательный фильтр для ' + path)
            validate(blob.decode('utf8'), path)
        if path.endswith('.db'):
            try:
                records = (json.loads(line) for line in blob.decode('utf8').splitlines() if line.strip())
                searchable = [value.encode('utf8') for record in records for value in string_values(record)]
            except (UnicodeError, json.JSONDecodeError):
                die('невозможно проверить NeDB в индексе: ' + path)
        else:
            searchable = [blob]
        if any(value in text for text in searchable for value in values):
            die('в индексе обнаружен секрет: ' + path)


def main():
    if len(sys.argv) < 2:
        die(__doc__)
    c = sys.argv[1]
    if c == 'clean':
        write_stdout(clean(read_stdin(), sys.argv[2]))
    elif c == 'smudge':
        write_stdout(smudge(read_stdin(), sys.argv[2]))
    elif c == 'validate':
        validate(read_stdin(), sys.argv[2])
    elif c == 'check-staged':
        check_staged()
    elif c == 'extract':
        cmd_extract('--force' in sys.argv)
    elif c == 'check':
        cmd_check()
    elif c == 'names':
        for p, spec in CONF['files'].items():
            for r in spec.get('rules', []):
                print(r['env'], '\t', p)
            if 'auto_fields' in spec:
                print('UNIT_<ID>_<ПОЛЕ>\t', p, '(поля: %s)' % ', '.join(spec['auto_fields']))
    else:
        die('неизвестная команда ' + c)


if __name__ == '__main__':
    main()
