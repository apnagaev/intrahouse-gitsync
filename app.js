const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const COMMANDS = ['refresh', 'sync', 'deploy', 'rollback', 'backup'];

module.exports = async function (plugin) {
  const P = plugin.params.data || {};
  const projectDir = (P.projectdir || '').trim();
  const dir = path.resolve(projectDir);
  const ops = path.join(__dirname, 'ops');
  const secrets = path.join(ops, 'ihsecrets.py');
  const branch = (P.branch || 'main').trim();
  const remote = (P.remote || 'origin').trim();
  const fetchMin = Number(P.fetchmin) >= 0 ? Number(P.fetchmin) : 15;
  const runner = (P.runner || 'systemd-run --collect --unit=ih-gitsync-%ts').trim();

  let channels = [];
  let busy = false;
  let timer = null;
  let resultTimer = null;

  if (!projectDir || !fs.existsSync(path.join(dir, '.git'))) {
    plugin.exit(8, 'В параметрах плагина укажите projectdir — каталог проекта с git (нет ' + path.join(dir || '?', '.git') + ')');
    return;
  }

  const env = Object.assign({}, process.env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' });
  if (P.sshkey) env.GIT_SSH_COMMAND = 'ssh -i ' + shellQuote(P.sshkey) + ' -o IdentitiesOnly=yes -o BatchMode=yes';

  // ------------------------------------------------------------ каналы
  async function loadChannels() {
    try {
      const list = plugin.channels && plugin.channels.get ? await plugin.channels.get() : await plugin.devhard.get();
      channels = (list || []).filter(c => !c.folder && c.chan);
    } catch (e) {
      plugin.log('Не удалось получить каналы: ' + e.message, 1);
    }
  }

  function send(values) {
    const have = new Set(channels.map(c => c.chan));
    const ts = Date.now();
    const data = Object.keys(values)
      .filter(k => have.has(k))
      .map(k => ({ id: k, value: values[k], ts }));
    if (data.length) plugin.sendData(data);
  }

  function result(text, level) {
    plugin.log(text, level === undefined ? 1 : level);
    send({ result: new Date().toLocaleString('ru-RU') + ': ' + text });
  }

  // ------------------------------------------------------------ git
  function run(cmd, args, opts) {
    return new Promise(resolve => {
      execFile(cmd, args, Object.assign({ cwd: dir, env, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, opts),
        (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, out: String(stdout).trim(), err: String(stderr).trim() }));
    });
  }
  const git = args => run('git', args);

  const state = await git(['rev-parse', '--absolute-git-dir']);
  if (state.code) throw new Error('Не найден служебный каталог Git');
  const last = path.join(state.out, 'ih-last-op');

  async function withLock(action) {
    const lock = spawn('flock', ['-n', path.join(state.out, 'ih-op.lock'),
      'sh', '-c', 'echo locked; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
    lock.stdin.on('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        lock.stdout.once('data', resolve);
        lock.once('error', reject);
        lock.once('exit', () => reject(new Error('Уже выполняется другая операция')));
      });
      await action();
    } finally {
      lock.stdin.end();
    }
  }

  async function changedFiles() {
    const r = await git(['status', '--porcelain', '-z', '--no-renames']);
    if (r.code) throw new Error('git status: ' + r.err);
    return r.out.split('\0').filter(Boolean).map(s => s.slice(3));
  }

  async function refresh(doFetch) {
    if (doFetch) {
      const f = await git(['fetch', '-q', '--', remote, branch]);
      if (f.code) throw new Error('Не удалось проверить репозиторий: ' + firstLine(f.err));
    }
    const files = await changedFiles();
    const local = await git(['log', '-1', '--format=%h %s']);
    const rem = await git(['log', '-1', '--format=%h %s', remote + '/' + branch]);
    const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...' + remote + '/' + branch]);
    const [ahead, behind] = counts.code ? [0, 0] : counts.out.split(/\s+/).map(Number);
    let status = 'ok';
    if (files.length) status = 'есть правки';
    if (behind) status = files.length ? 'есть правки и обновления' : 'есть обновления';
    send({
      status: busy ? 'выполняется' : status,
      uncommitted: files.length, behind, ahead,
      local: local.out, remote: rem.code ? '' : rem.out, busy: busy ? 1 : 0,
    });
    return { files, behind, ahead };
  }

  // Файлы базы intraHouse (nedb) — по объекту JSON на строку. Если файл пойман в момент записи,
  // строка будет обрезана — тогда не коммитим, а просим повторить.
  function brokenDb(files) {
    for (const f of files) {
      if (!f.endsWith('.db')) continue;
      const full = path.join(dir, f);
      if (!fs.existsSync(full)) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try { JSON.parse(lines[i]); } catch (e) { return f + ':' + (i + 1); }
      }
    }
    return null;
  }

  // ------------------------------------------------------------ действия
  async function doSync() {
    const { files, ahead, behind } = await refresh(true);
    const current = await git(['symbolic-ref', '--short', 'HEAD']);
    if (current.code || current.out !== branch) throw new Error('Выберите настроенную ветку проекта');
    if (!files.length && !ahead) return result('Отправлять нечего: правок из интерфейса нет');
    const pending = path.join(state.out, 'gitsync', 'pending-sync');
    if (ahead) {
      const tip = await git(['rev-parse', 'HEAD']);
      if (!fs.existsSync(pending) || fs.readFileSync(pending, 'utf8').trim() !== tip.out) {
        throw new Error('Есть локальные коммиты без отметки проверки gitsync');
      }
    }
    if (files.length && ahead && behind) throw new Error('Сначала согласуйте локальную ветку с GitHub');
    if (files.length) {
      const broken = brokenDb(files);
      if (broken) throw new Error('Файл записывается сейчас: ' + broken);
      const index = await git(['diff', '--cached', '--quiet']);
      if (index.code) throw new Error('Git-индекс должен быть пуст перед отправкой');
      const clean = await git(['config', '--get', 'filter.ihsecrets.clean']);
      if (clean.out !== 'python3 ' + shellQuote(secrets) + ' clean %f') {
        throw new Error('Настройте установленный фильтр gitsync');
      }
      try {
        const added = await git(['add', '-A']);
        if (added.code) throw new Error('Git не смог подготовить изменения');
        const check = await run('python3', [secrets, 'check']);
        if (check.code) throw new Error('Проверка секретов не прошла: ' + firstLine(check.err || check.out));
        const indexCheck = await run('python3', [secrets, 'check-staged']);
        if (indexCheck.code) throw new Error('Git-индекс не прошёл проверку: ' + firstLine(indexCheck.err));
        const staged = await git(['diff', '--cached', '--quiet']);
        if (staged.code === 1) {
          const commit = await git(['commit', '-q', '-m', 'Правки из интерфейса intraHouse ' + stamp()]);
          if (commit.code) throw new Error('Коммит не создан: ' + firstLine(commit.err || commit.out));
          const tip = await git(['rev-parse', 'HEAD']);
          fs.writeFileSync(pending, tip.out + '\n', { mode: 0o600 });
        } else if (staged.code || !ahead) {
          return result('Изменений для коммита нет');
        }
      } finally {
        await git(['reset', '--mixed', 'HEAD']);
      }
    }

    const r = await git(['push', '-q', '--', remote, 'HEAD:refs/heads/' + branch]);
    if (!r.code) {
      if (fs.existsSync(pending)) fs.unlinkSync(pending);
      return result('Отправлено в ' + branch);
    }

    // Distinguish non-fast-forward from network, auth and other push errors.
    const fetched = await git(['fetch', '-q', '--', remote, branch]);
    if (fetched.code) return result('Push не удался; fetch тоже не удался: ' + firstLine(fetched.err || r.err), 0);
    const ancestor = await git(['merge-base', '--is-ancestor', remote + '/' + branch, 'HEAD']);
    if (ancestor.code !== 1) return result('Push не удался (не конфликт версий): ' + firstLine(r.err), 0);
    const side = 'ui/' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const r2 = await git(['push', '-q', '--', remote, 'HEAD:refs/heads/' + side]);
    if (r2.code) return result('Не отправлено: ' + firstLine(r.err), 0);
    result('В репозитории есть новые изменения. Правки отправлены в ветку ' + side +
      '. Влейте ветку через PR с сохранением локального коммита в истории', 1);
  }

  async function launch(operation) {
    if (operation === 'deploy') {
      const status = await refresh(true);
      if (status.ahead || status.files.some(file => file !== 'jbase/devparam.db')) throw new Error('Сперва отправьте или согласуйте локальные правки');
      if (!status.behind) return result('Получать нечего: проект совпадает с Git');
    }
    const [command, ...args] = runner.replace('%ts', String(Date.now())).split(/\s+/);
    if (!args.some(arg => arg === '--uid' || arg.startsWith('--uid='))) {
      args.push('--uid=' + process.getuid());
    }
    // systemd-run may start with a different environment and working directory.
    if (env.GIT_SSH_COMMAND) args.push('--setenv=GIT_SSH_COMMAND=' + env.GIT_SSH_COMMAND);
    if (env.IHSECRETS_ENV) args.push('--setenv=IHSECRETS_ENV=' + env.IHSECRETS_ENV);
    args.push('--setenv=GIT_TERMINAL_PROMPT=0', '/bin/sh', path.join(ops, 'project.sh'),
      operation, dir, remote, branch);
    const launched = await run(command, args);
    if (launched.code) throw new Error('Не удалось запустить службу: ' + firstLine(launched.err));
    result('Служба приняла операцию ' + operation);
  }

  async function act(name) {
    if (busy) {
      send({ [name]: 0 });
      return result('Уже выполняется другое действие', 1);
    }
    busy = true;
    send({ busy: 1, status: 'выполняется' });
    try {
      if (name === 'refresh') { await refresh(true); result('Состояние обновлено', 2); }
      if (name === 'sync') await withLock(doSync);
      if (['deploy', 'rollback', 'backup'].includes(name)) await launch(name);
    } catch (e) {
      result('Ошибка: ' + e.message, 0);
    } finally {
      busy = false;
      try { await refresh(false); } catch (e) { /* ignore */ }
      send({ [name]: 0 });
    }
  }

  // ------------------------------------------------------------ команды из intraHouse
  // Команда приходит с идентификатором канала. У скопированных в интерфейсе каналов он не совпадает
  // с полем «Канал» (например statusNaN, status_COPY), поэтому ищем канал по любому из его ключей.
  function commandName(item) {
    for (const key of [item.chan, item.id, item.dn, item.prop]) {
      if (key === undefined || key === null) continue;
      if (COMMANDS.includes(key)) return key;
      const ch = channels.find(c => c.chan === key || c.id === key || c._id === key);
      if (ch && COMMANDS.includes(ch.chan)) return ch.chan;
    }
    return null;
  }

  plugin.onAct(message => {
    plugin.log('onAct: ' + JSON.stringify(message && message.data), 2);
    (message.data || []).forEach(item => {
      const name = commandName(item);
      if (!name) { plugin.log('Команда не распознана: ' + JSON.stringify(item), 1); return; }
      if (Number(item.value) === 0 || item.value === false) return; // сброс кнопки
      plugin.log('Команда ' + name, 1);
      act(name);
    });
  });

  if (plugin.channels && plugin.channels.onChange) plugin.channels.onChange(loadChannels);
  else if (plugin.onChange) plugin.onChange('channels', loadChannels);

  plugin.onStop && plugin.onStop(() => {
    if (timer) clearInterval(timer);
    if (resultTimer) clearInterval(resultTimer);
    plugin.exit();
  });

  // ------------------------------------------------------------ старт
  await loadChannels();
  let lastOperation;
  function publishOperation() {
    if (!fs.existsSync(last)) return;
    const value = fs.readFileSync(last, 'utf8').trim();
    if (value && value !== lastOperation) {
      lastOperation = value;
      send({ result: value });
    }
  }
  send({ refresh: 0, sync: 0, deploy: 0, rollback: 0, backup: 0, busy: 0,
         result: 'Плагин запущен ' + stamp() });
  publishOperation();
  resultTimer = setInterval(() => { try { publishOperation(); } catch (e) { plugin.log(e.message, 1); } }, 2000);
  try { await refresh(fetchMin > 0); } catch (e) { result(e.message, 1); await refresh(false); }
  if (fetchMin > 0) timer = setInterval(() => { if (!busy) refresh(true).catch(() => {}); }, fetchMin * 60000);
  plugin.log('gitsync: ' + dir + ', ветка ' + branch + (fetchMin ? ', проверка раз в ' + fetchMin + ' мин' : ''), 1);
};

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function firstLine(s) { return String(s || '').split('\n')[0].slice(0, 200); }
function shellQuote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
