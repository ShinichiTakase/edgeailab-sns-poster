// microCMS REST APIへの共通アクセスヘルパー。customerStore.js / postingLogStore.js から共用する。
function getBaseUrl() {
  const domain = process.env.MICROCMS_SERVICE_DOMAIN;
  if (!domain) return null;
  return `https://${domain}.microcms.io/api/v1`;
}

function getApiKey() {
  return process.env.MICROCMS_WRITE_API_KEY || process.env.MICROCMS_API_KEY;
}

async function microcmsFetch(pathAndQuery, options = {}) {
  const base = getBaseUrl();
  const key = getApiKey();
  if (!base || !key) {
    throw new Error("MICROCMS_SERVICE_DOMAIN または MICROCMS_API_KEY が未設定です");
  }
  const res = await fetch(`${base}${pathAndQuery}`, {
    ...options,
    headers: {
      "X-MICROCMS-API-KEY": key,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  return res;
}

module.exports = { microcmsFetch };
