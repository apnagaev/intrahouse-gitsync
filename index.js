/**
 * gitsync — плагин intraHouse 5: git проекта по кнопке.
 */
const util = require('util');

let plugin;

process.on('unhandledRejection', reason => {
  if (plugin && plugin.log) plugin.log('UNHANDLED REJECTION: ' + util.inspect(reason), 0);
});

(async () => {
  try {
    const opt = JSON.parse(process.argv[2] || '{}');
    plugin = require((opt.pluginapi || 'ih-plugin-api') + '/index.js')();
    plugin.log('Плагин gitsync стартовал', 0);
    plugin.params.data = await plugin.params.get();
    if (plugin.logger && plugin.logger.setParams) plugin.logger.setParams(plugin.params.data);
    await require('./app')(plugin);
  } catch (err) {
    if (plugin && plugin.exit) plugin.exit(8, 'Ошибка: ' + util.inspect(err));
    else process.exit(8);
  }
})();
