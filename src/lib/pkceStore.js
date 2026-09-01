// PKCE code_verifier / slug の一時保存。単一インスタンス運用のためメモリ内で十分。
const TTL_MS = 10 * 60 * 1000;

const store = new Map();

function put(state, data) {
  store.set(state, { ...data, expiresAt: Date.now() + TTL_MS });
}

// 一度読んだstateは再利用されないよう即時削除する（リプレイ対策）。
function take(state) {
  const entry = store.get(state);
  if (!entry) return null;
  store.delete(state);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

// unref(): このタイマーの存在だけでプロセスの終了を妨げないようにする
// （2026-09-01、pkceStoreを新たにrequireしたsnsConnections.jsのテストが、
// このintervalのせいでプロセスが自然終了せずタイムアウトする問題が発覚したため）。
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of store) {
    if (now > value.expiresAt) store.delete(key);
  }
}, 5 * 60 * 1000).unref();

module.exports = { put, take };
