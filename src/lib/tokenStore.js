// クライアントごとのSNSトークンを json/client_tokens.json に読み書きするユーティリティ。
// クライアント数が増えたらDB移行を検討する前提の暫定実装（現状はファイルベース）。
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "..", "json", "client_tokens.json");

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  const raw = fs.readFileSync(STORE_PATH, "utf-8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

// slug（クライアント識別子）の指定プラットフォームのデータだけを上書きし、
// 他プラットフォーム（将来のx等）のデータは保持する。
function savePlatformTokens(slug, platform, data) {
  const store = loadStore();
  const existing = store[slug] || {};
  store[slug] = { ...existing, [platform]: data };
  saveStore(store);
  return store[slug];
}

// 指定platformのエントリのうち user_id が一致するものを全slugから削除する。
// 他platform（threads/x等）のデータは保持する。Facebookのデータ削除コールバックで使用。
function deletePlatformTokensByUserId(platform, userId) {
  const store = loadStore();
  const affectedSlugs = [];
  for (const slug of Object.keys(store)) {
    const entry = store[slug][platform];
    if (entry && entry.user_id === userId) {
      delete store[slug][platform];
      if (Object.keys(store[slug]).length === 0) delete store[slug];
      affectedSlugs.push(slug);
    }
  }
  if (affectedSlugs.length > 0) saveStore(store);
  return affectedSlugs;
}

module.exports = { loadStore, saveStore, savePlatformTokens, deletePlatformTokensByUserId };
