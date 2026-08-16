// Anthropicクライアントの初期化を一元化する。stripeClient.jsと同じパターン
// （未設定ならnullを返す。呼び出し側は投稿本体には影響しない機能なので、
// 未設定時は「AI機能が使えない」エラーを返すに留める）。
const Anthropic = require("@anthropic-ai/sdk");

function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

module.exports = { getAnthropic };
