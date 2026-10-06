const { getDataSourceName } = require("./dataSource");
function selectStore(name, legacy) {
  if (getDataSourceName() === "microcms") return legacy;
  return require("./sqliteStoreAdapters").createSqliteStore(name, legacy);
}
module.exports = { selectStore };
