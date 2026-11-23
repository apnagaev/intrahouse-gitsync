/**
 * gitsync: каталог проекта intraHouse — рабочая копия git-репозитория.
 *
 * Каналы (chan):
 *   чтение:  status, uncommitted, behind, ahead, local, remote, result, busy
 *   команды: refresh, sync, deploy, rollback  — запись 1 (кнопка) запускает действие
 *
 * sync     — коммит правок из интерфейса (секреты срезает git-фильтр ihsecrets) и push.
 * deploy   — запускает tools/ih-deploy.sh ОТДЕЛЬНОЙ службой (systemd-run): скрипт останавливает
 *            intraHouse вместе с этим плагином, делает снимок, git pull, запускает intraHouse.
 * rollback — так же запускает tools/ih-rollback.sh --latest.
 * Результат деплоя/отката скрипты пишут в .git/ih-last-op — плагин показывает его после перезапуска.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const COMMANDS = ['refresh', 'sync', 'deploy', 'rollback'];

module.exports = async function (plugin) {
  const P = plugin.params.data || {};
  const dir = (P.projectdir || '').trim();
  const branch = (P.branch || 'main').trim();
  const remote = (P.remote || 'origin').trim();
  const fetchMin = Number(P.fetchmin) >= 0 ? Number(P.fetchmin) : 15;
  const runner = (P.runner || 'systemd-run --collect --unit=ih-gitsync-%ts').trim();

  let channels = [];
  let busy = false;
  let timer = null;

  if (!dir || !fs.existsSync(path.join(dir, '.git'))) {
    plugin.exit(8, 'В параметрах плагина укажите projectdir — каталог проекта с git (нет ' + path.join(dir || '?', '.git') + ')');
    return;
  }

  const env = Object.assign({}, process.env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' });
  if (P.sshkey) env.GIT_SSH_COMMAND = 'ssh -i ' + P.sshkey + ' -o IdentitiesOnly=yes -o BatchMode=yes';

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

  async function changedFiles() {
    const r = await git(['status', '--porcelain', '-z']);
    if (r.code) throw new Error('git status: ' + r.err);
    return r.out.split('\0').filter(Boolean).map(s => s.slice(3));
  }

  async function refresh(doFetch) {
    if (doFetch) {
      const f = await git(['fetch', '-q', remote, branch]);
      if (f.code) result('Не удалось проверить репозиторий: ' + firstLine(f.err), 1);
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
  // Check exact staged blobs: clean filters can change bytes between disk and Git.
  async function checkStagedSecrets() {
    const envFile = path.join(dir, '.env');
    if (!fs.existsSync(envFile)) throw new Error('Нет .env: отправка заблокирована');
    const values = fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
      .filter(line => line && !/^\s*#/.test(line) && line.includes('='))
      .map(line => line.slice(line.indexOf('=') + 1))
      .filter(value => value.length >= 4);
    const names = await git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
    if (names.code) throw new Error('Не удалось получить индекс Git');
    const staged = names.out.split('\0').filter(Boolean);
    for (const file of staged) {
      if (file === '.env' || file.startsWith('private/')) throw new Error('Запрещённый файл в индексе: ' + file);
      if (['jbase/globals.db', 'jbase/units.db', 'project.json'].includes(file)) {
        const attr = await git(['check-attr', 'filter', '--', file]);
        if (attr.code || !attr.out.endsWith(': ihsecrets')) throw new Error('Не настроен фильтр ihsecrets: ' + file);
        const required = await git(['config', '--get', 'filter.ihsecrets.required']);
        if (required.code || required.out !== 'true') throw new Error('Фильтр ihsecrets не является обязательным');
      }
      const blob = await git(['show', ':' + file]);
      if (blob.code) throw new Error('Не удалось проверить индекс: ' + file);
      if (values.some(value => blob.out.includes(value))) throw new Error('В индексе обнаружен секрет: ' + file);
    }
  }

  async function doSync() {
    const { files } = await refresh(true);
    if (!files.length) return result('Отправлять нечего: правок из интерфейса нет');
    const broken = brokenDb(files);
    if (broken) return result('Файл записывается прямо сейчас (' + broken + '), повторите через минуту', 1);

    let r = await git(['add', '-A']);
    if (r.code) return result('git add: ' + firstLine(r.err), 0);
    // Validate after git add and before creating any commit.
    const chk = await run('python3', ['tools/ihsecrets.py', 'check']);
    if (chk.code) return result('Отправка заблокирована: проверка секретов не прошла (' + firstLine(chk.err || chk.out) + ')', 0);
    try { await checkStagedSecrets(); }
    catch (e) { return result('Отправка заблокирована: ' + e.message, 0); }
    const msg = 'Правки из интерфейса intraHouse ' + stamp();
    r = await git(['commit', '-q', '-m', msg]);
    if (r.code) return result('Коммит не создан: ' + firstLine(r.err || r.out), 0);

    r = await git(['push', '-q', remote, 'HEAD:' + branch]);
    if (!r.code) return result('Отправлено в ' + branch + ': ' + files.length + ' файл(ов)');

    // Distinguish non-fast-forward from network, auth and other push errors.
    const fetched = await git(['fetch', '-q', remote, branch]);
    if (fetched.code) return result('Push не удался; fetch тоже не удался: ' + firstLine(fetched.err || r.err), 0);
    const ancestor = await git(['merge-base', '--is-ancestor', remote + '/' + branch, 'HEAD']);
    if (ancestor.code !== 1) return result('Push не удался (не конфликт версий): ' + firstLine(r.err), 0);
    const side = 'ui/' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const r2 = await git(['push', '-q', remote, 'HEAD:refs/heads/' + side]);
    if (r2.code) return result('Не отправлено: ' + firstLine(r.err), 0);
    result('В репозитории есть новые изменения. Правки отправлены в ветку ' + side +
      '; нажмите «Получить» — они сольются при развёртывании', 1);
  }

  async function launch(script, args, what) {
    const st = await refresh(true);
    if (what === 'deploy' && !st.behind && !st.files.length) return result('Получать нечего: репозиторий и проект совпадают');
    const unit = runner.replace('%ts', String(Date.now()));
    const parts = unit.split(/\s+/).filter(Boolean);
    const cmd = parts.concat([path.join(dir, 'tools', script)], args);
    result((what === 'deploy' ? 'Развёртывание запущено' : 'Откат запущен') + ': intraHouse будет перезапущен', 1);
    const child = spawn(cmd[0], cmd.slice(1), { cwd: dir, env, detached: true, stdio: 'ignore' });
    child.on('error', e => result('Не удалось запустить ' + script + ': ' + e.message, 0));
    child.unref();
  }

  async function act(name) {
    if (busy) return result('Уже выполняется другое действие', 1);
    busy = true;
    send({ busy: 1, status: 'выполняется' });
    try {
      if (name === 'refresh') { await refresh(true); result('Состояние обновлено', 2); }
      if (name === 'sync') await doSync();
      if (name === 'deploy') await launch('ih-deploy.sh', [], 'deploy');
      if (name === 'rollback') await launch('ih-rollback.sh', ['--latest'], 'rollback');
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
    plugin.exit();
  });

  // ------------------------------------------------------------ старт
  await loadChannels();
  const last = path.join(dir, '.git', 'ih-last-op');
  send({ refresh: 0, sync: 0, deploy: 0, rollback: 0, busy: 0,
         result: fs.existsSync(last) ? fs.readFileSync(last, 'utf8').trim() : 'Плагин запущен ' + stamp() });
  await refresh(fetchMin > 0);
  if (fetchMin > 0) timer = setInterval(() => { if (!busy) refresh(true).catch(() => {}); }, fetchMin * 60000);
  plugin.log('gitsync: ' + dir + ', ветка ' + branch + (fetchMin ? ', проверка раз в ' + fetchMin + ' мин' : ''), 1);
};

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function firstLine(s) { return String(s || '').split('\n')[0].slice(0, 200); }
function lastLine(s) { const l = String(s || '').trim().split('\n'); return l[l.length - 1].slice(0, 200); }
