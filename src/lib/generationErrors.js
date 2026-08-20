// URL取得(urlTextFetcher.js)・AI生成(postCopyGenerator.js/videoGenerator.js)それぞれの
// エラーを、フロントエンド表示用の安定したエラーコードへ分類する共通ロジック。
// ワンショット投稿・スケジュール投稿の両方（routes/ai.js, lib/videoGenerationJobStore.js）
// から呼び出され、同じ原因には同じコードを返すことで表示メッセージを一本化する。
// fetch系はurl_接頭辞、AI生成系はai_接頭辞のコードにし、文言が混同されないようにしている。

/** urlTextFetcher.fetchUrlTextが投げたエラーを分類する。 */
function classifyFetchError(err) {
  const msg = err && err.message;
  if (msg === "invalid_url" || msg === "invalid_url_protocol") {
    return { code: "invalid_url", status: 400 };
  }
  if (msg === "fetch_timeout") {
    return { code: "url_fetch_timeout", status: 400 };
  }
  if (msg === "empty_content") {
    return { code: "url_content_too_short", status: 400 };
  }
  const httpStatusMatch = /^fetch_failed_(\d+)$/.exec(msg || "");
  if (httpStatusMatch) {
    const httpStatus = Number(httpStatusMatch[1]);
    if (httpStatus === 404) return { code: "url_not_found", status: 400 };
    if (httpStatus === 403) return { code: "url_access_denied", status: 400 };
    if (httpStatus >= 500) return { code: "url_server_error", status: 400 };
    // 401/410/429等、判別対象外のHTTPステータスは汎用フォールバックへ。
    return { code: "url_fetch_failed", status: 400 };
  }
  // url_not_allowed（SSRF対策によるプライベートIP等の拒否。理由を露出させないためあえて汎用扱い）、
  // unsupported_content_type、network_error（DNS失敗・接続拒否等）、その他未知のエラーは
  // すべて既存の汎用メッセージにフォールバックする。
  return { code: "url_fetch_failed", status: 400 };
}

/** postCopyGenerator/videoGenerator（Anthropic API呼び出し）が投げたエラーを分類する。 */
function classifyGenerationError(err) {
  if (err && err.message === "anthropic_not_configured") {
    return { code: "ai_not_configured", status: 500 };
  }
  if (err && err.message === "ai_refusal") {
    return { code: "ai_refusal", status: 422 };
  }
  if (err && err.message === "ai_output_truncated") {
    return { code: "ai_output_truncated", status: 422 };
  }
  if (err && err.constructor && err.constructor.name === "APIConnectionTimeoutError") {
    return { code: "ai_timeout", status: 504 };
  }
  // Anthropic SDKのAPIErrorサブクラスはHTTPステータスを.statusに保持する
  // （RateLimitError=429固定、InternalServerError=5xx）。型でのimportより、この方が
  // SDKのバージョン差異に依存しない。
  if (err && err.status === 429) {
    return { code: "ai_rate_limited", status: 503 };
  }
  if (err && typeof err.status === "number" && err.status >= 500) {
    return { code: "ai_server_error", status: 502 };
  }
  return { code: "ai_generation_failed", status: 502 };
}

module.exports = { classifyFetchError, classifyGenerationError };
