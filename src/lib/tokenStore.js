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

// 指定platformの識別子（x/threads/instagramはuser_id、facebookはpages[].pageId）が
// 自分（excludeSlug）以外の既存slugで既に使われていないか横断検索する。
// identifiersは常に配列（facebookは複数ページを一括チェックするため）。
function findDuplicateOwner(platform, identifiers, excludeSlug) {
  const store = loadStore();
  for (const slug of Object.keys(store)) {
    if (slug === excludeSlug) continue;
    const entry = store[slug] && store[slug][platform];
    if (!entry) continue;

    if (platform === "facebook") {
      const pageIds = (entry.pages || []).map((p) => p.pageId);
      const matched = identifiers.find((id) => pageIds.includes(id));
      if (matched) return { slug, identifier: matched };
    } else if (identifiers.includes(entry.user_id)) {
      return { slug, identifier: entry.user_id };
    }
  }
  return null;
}

module.exports = {
  loadStore,
  saveStore,
  savePlatformTokens,
  deletePlatformTokensByUserId,
  findDuplicateOwner,
};
