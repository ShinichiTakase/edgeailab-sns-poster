function withTransaction(db, work, { mode = "IMMEDIATE" } = {}) {
  if (!db || typeof work !== "function") throw new TypeError("db and work are required");
  const normalizedMode = String(mode).toUpperCase();
  if (!["DEFERRED", "IMMEDIATE", "EXCLUSIVE"].includes(normalizedMode)) throw new Error("invalid transaction mode");
  db.exec(`BEGIN ${normalizedMode}`);
  try {
    const result = work(db);
    if (result && typeof result.then === "function") {
      throw new Error("transaction callbacks must be synchronous; call external APIs outside transactions");
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = { withTransaction };
