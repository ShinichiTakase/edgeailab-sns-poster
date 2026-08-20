// Anthropicクライアントの初期化を一元化する。stripeClient.jsと同じパターン
// （未設定ならnullを返す。呼び出し側は投稿本体には影響しない機能なので、
// 未設定時は「AI機能が使えない」エラーを返すに留める）。
const Anthropic = require("@anthropic-ai/sdk");

// クライアントをモジュールスコープで使い回す（シングルトン）。以前は呼び出しごとに
// `new Anthropic()`していたため、リクエストのたびにHTTP接続（TCP/TLSハンドシェイク）が
// 使い回されず、並行リクエストが重なった際にETIMEDOUTで接続エラーになるケースが実際に
// 発生していた。SDK公式推奨（1インスタンスを使い回す）に合わせ、KeepAlive接続の再利用が
// 効くようにした。
let cachedClient = null;

function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey: key });
  }
  return cachedClient;
}

module.exports = { getAnthropic };
