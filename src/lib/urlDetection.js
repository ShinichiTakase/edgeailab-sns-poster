// 投稿文にURLが含まれるかどうかの判定ロジックの単一情報源。
// Xサーチャージ対象判定・請求予測の両方で使う（誤検知を避けるためプロトコル省略記法は対象外）。
const URL_PATTERN = /https?:\/\//;

function containsUrl(text) {
  return URL_PATTERN.test(text || "");
}

module.exports = { URL_PATTERN, containsUrl };
