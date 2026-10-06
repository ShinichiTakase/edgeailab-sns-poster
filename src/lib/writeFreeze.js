const fs = require("fs");

const DEFAULT_SENTINEL = "/run/edgeailab-sns-poster-write-freeze";

function sentinelPath(env = process.env) {
  return env.SNS_POSTER_WRITE_FREEZE_PATH || DEFAULT_SENTINEL;
}

function isWriteFrozen({ env = process.env, existsSync = fs.existsSync } = {}) {
  return existsSync(sentinelPath(env));
}

function assertWritesAllowed(options) {
  if (isWriteFrozen(options)) {
    const error = new Error("sns-poster writes are frozen");
    error.code = "WRITE_FREEZE_ACTIVE";
    throw error;
  }
}

function isWriteRequest(req) {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const pathname = req.path || req.url?.split("?")[0] || "";
  return pathname.startsWith("/oauth/") || pathname === "/api/auth/verify" || /\/callback\/?$/.test(pathname);
}

function writeFreezeMiddleware(options = {}) {
  return (req, res, next) => {
    if (isWriteRequest(req) && isWriteFrozen(options)) {
      res.setHeader("Retry-After", "300");
      return res.status(503).json({ error: "maintenance_write_freeze" });
    }
    next();
  };
}

module.exports = { DEFAULT_SENTINEL, sentinelPath, isWriteFrozen, assertWritesAllowed, isWriteRequest, writeFreezeMiddleware };
