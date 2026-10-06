const crypto = require("crypto");
const { withTransaction } = require("../db/transaction");

const SECRET = /token|password|secret|ciphertext|cookie|authorization/i;
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET.test(key) ? "[REDACTED]" : redact(item)]));
}

function createChangeJournal(db, { now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() } = {}) {
  function record({ transactionId, entityType, entityId, operation, before = null, after = null }) {
    db.prepare(`INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
      VALUES (?,?,?,?,?,?,?)`).run(transactionId, entityType, String(entityId), operation,
        before == null ? null : JSON.stringify(redact(before)), after == null ? null : JSON.stringify(redact(after)), now());
  }
  function mutate({ entityType, entityId, operation, before = null, after = null }, callback) {
    const transactionId = uuid();
    return withTransaction(db, () => {
      const result = callback(transactionId);
      record({ transactionId, entityType, entityId, operation, before, after: typeof after === "function" ? after(result) : after });
      return result;
    });
  }
  return { record, mutate };
}

module.exports = { redact, createChangeJournal };
