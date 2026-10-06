const { getDataSourceName } = require("./dataSource");
function selectStore(name, legacy) {
  if (process.env.NODE_ENV === "test" && process.env.SNS_POSTER_DATA_SOURCE === "test-legacy") return legacy;
  getDataSourceName();
  return require("./sqliteStoreAdapters").createSqliteStore(name, legacy);
}
module.exports = { selectStore };
