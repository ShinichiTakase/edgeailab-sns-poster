// facebook.js/instagram.js ルートで使っているファイル永続化ログ（json/配下、
// docker logsのローテーションで消える前の記録用）を、単発実行スクリプトからも
// 使えるように切り出したもの。
const fs = require("fs");
const path = require("path");

function createLogger(logFileName) {
  const LOG_FILE = path.join(process.env.SNS_POSTER_LOG_DIR || path.join(__dirname, "..", "..", "json"), logFileName);

  function writeLogFile(level, args) {
    const message = args
      .map((a) => (a instanceof Error ? a.stack : typeof a === "object" ? JSON.stringify(a) : a))
      .join(" ");
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    try {
      fs.appendFileSync(LOG_FILE, line);
    } catch (err) {
      console.error(`[logger] failed to write log file ${logFileName}:`, err);
    }
  }

  return {
    logInfo(...args) {
      console.info(...args);
      writeLogFile("info", args);
    },
    logWarn(...args) {
      console.warn(...args);
      writeLogFile("warn", args);
    },
    logError(...args) {
      console.error(...args);
      writeLogFile("error", args);
    },
  };
}

module.exports = { createLogger };
