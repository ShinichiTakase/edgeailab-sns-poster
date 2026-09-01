// 導入時一回限り: 既存の json/client_tokens.json の全エントリを json/sns_history.json へ
// 一括投入する（2026-09-01、トライアル濫用防止のためsns_history.jsonを新設した際に実施）。
//
// sns_history.jsonはcustomerのライフサイクル（解約・SNS連携解除）から独立して「このSNS
// アカウントは過去に連携されたことがある」という事実を残すための台帳（詳細は
// src/lib/snsHistoryStore.js・docs/内部仕様_SNS連携.md参照）。導入前に既に解約・連携解除
// 済みで client_tokens.json から消えてしまった過去の連携は、データ自体が残っていないため
// 復元できない（既知の限界として許容）。
//
// recordNewIdentifiers は未記録のキーのみ追記する設計のため、複数回実行しても安全
// （冪等）。
//   node src/scripts/backfillSnsHistory.js          → 投入対象の確認のみ（dry-run）
//   node src/scripts/backfillSnsHistory.js --apply  → 実際に投入
const { loadStore } = require("../lib/tokenStore");
const { loadHistory, recordNewIdentifiers } = require("../lib/snsHistoryStore");

const APPLY = process.argv.includes("--apply");

function identifiersFor(platform, entry) {
  if (platform === "facebook") {
    return (entry.pages || []).map((p) => p.pageId);
  }
  return entry.user_id ? [entry.user_id] : [];
}

function run() {
  const store = loadStore();
  const beforeHistory = loadHistory();
  const beforeKeyCount = Object.keys(beforeHistory).length;

  let candidateCount = 0;
  for (const slug of Object.keys(store)) {
    for (const platform of Object.keys(store[slug])) {
      const entry = store[slug][platform];
      const identifiers = identifiersFor(platform, entry);
      candidateCount += identifiers.length;

      if (APPLY) {
        const connectedAt = entry.updated_at || new Date().toISOString();
        recordNewIdentifiers(platform, identifiers, slug, connectedAt);
      }
    }
  }

  if (APPLY) {
    const afterKeyCount = Object.keys(loadHistory()).length;
    console.info(
      `[backfill-sns-history] APPLY完了。client_tokens.json ${Object.keys(store).length}顧客分、` +
        `延べ${candidateCount}識別子を確認。sns_history.jsonのキー数: ${beforeKeyCount} → ${afterKeyCount}`
    );
  } else {
    console.info(
      `[backfill-sns-history] DRY-RUNモード。client_tokens.json ${Object.keys(store).length}顧客分、` +
        `延べ${candidateCount}識別子が投入対象候補（既存のsns_history.jsonキー数: ${beforeKeyCount}）。` +
        `実際に投入するには --apply を付けて再実行してください。`
    );
  }
}

run();
