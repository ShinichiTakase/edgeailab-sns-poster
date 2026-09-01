// SNSアカウントが過去に連携されたことがあるかを、customerのライフサイクル（解約・
// 連携解除）から独立して永続記録する台帳（2026-09-01追加、トライアル濫用防止）。
//
// json/client_tokens.json はcustomerと運命を共にし、正規の解約（POST /api/account/cancel）や
// 顧客自身によるSNS連携解除（POST /api/sns-connections/:platform/disconnect）で消えてしまう。
// そのため「このSNSアカウントは過去に誰かのトライアルで使われたことがある」という事実を
// 覚えておく場所がclient_tokens.jsonの外に必要（でなければ、トライアル消費→解約/連携解除→
// 別メールで再サインアップ→同じSNSアカウントを再連携、を繰り返すだけで無限にトライアルを
// 使い回せてしまう）。
//
// 想定ユーザー数は最大500件のため、client_tokens.jsonと同様にDBではなくJSONファイルで十分な
// 性能が出る想定。
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "..", "json", "sns_history.json");

function loadHistory() {
  if (!fs.existsSync(STORE_PATH)) return {};
  const raw = fs.readFileSync(STORE_PATH, "utf-8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function saveHistory(history) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(history, null, 2) + "\n", "utf-8");
}

function historyKey(platform, accountId) {
  return `${platform}:${accountId}`;
}

// identifiers配列（facebookは複数ページのpageId、他プラットフォームは要素1つのuser_id/sub）の
// うち、自分（currentCustomerId）以外の顧客が最初に連携した記録が残っているものを探す。
// tokenStore.findDuplicateOwnerと同じく、最初に見つかった1件だけを返す（facebookで複数
// ページが同時にヒットしても、判定の粒度はfindDuplicateOwnerと揃える）。
function findOtherCustomerHit(platform, identifiers, currentCustomerId) {
  const history = loadHistory();
  for (const id of identifiers) {
    const key = historyKey(platform, id);
    const entry = history[key];
    if (entry && entry.firstCustomerId !== currentCustomerId) {
      return {
        key,
        identifier: id,
        firstCustomerId: entry.firstCustomerId,
        firstConnectedAt: entry.firstConnectedAt,
      };
    }
  }
  return null;
}

// まだ記録の無いidentifierだけを追記する。既に記録がある場合（自分自身の過去の連携を
// 含む）は「最初の連携者・最初の連携日時」を不変の値として扱うため、一切上書きしない。
function recordNewIdentifiers(platform, identifiers, customerId, connectedAt) {
  const history = loadHistory();
  let changed = false;
  for (const id of identifiers) {
    const key = historyKey(platform, id);
    if (!history[key]) {
      history[key] = { firstCustomerId: customerId, firstConnectedAt: connectedAt };
      changed = true;
    }
  }
  if (changed) saveHistory(history);
}

module.exports = { loadHistory, saveHistory, historyKey, findOtherCustomerHit, recordNewIdentifiers };
