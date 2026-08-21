// 投稿文にURLが含まれるかどうかの判定ロジックの単一情報源。
// Xサーチャージ対象判定・請求予測の両方で使う（誤検知を避けるためプロトコル省略記法は対象外）。
const URL_PATTERN = /https?:\/\//;

// 本文からURL部分だけを抜き出す（Facebook Graph APIのlinkパラメータ用。facebookPoster.js参照）。
// 日本語の地の文にURLが直接続くケース（「。」「」」等）を誤って含めないよう区切り文字で止める。
const URL_EXTRACT_PATTERN = /https?:\/\/[^\s、。，,」』】\)]+/;

function containsUrl(text) {
  return URL_PATTERN.test(text || "");
}

function extractFirstUrl(text) {
  const match = (text || "").match(URL_EXTRACT_PATTERN);
  return match ? match[0] : null;
}

module.exports = { URL_PATTERN, containsUrl, extractFirstUrl };
