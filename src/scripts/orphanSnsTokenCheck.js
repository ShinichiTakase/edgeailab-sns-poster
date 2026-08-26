// json/client_tokens.json（SNSトークン置き場、暫定のファイルベース実装）は、
// customersレコードの削除・状態変更と連動する仕組みを持たない。正規の解約導線
// （POST /api/account/cancel）はトークンも道連れに削除するが、microCMS管理画面から
// customersレコードを直接削除した場合はこのファイルにトークンだけが取り残され、
// 実在しない顧客のslug（実体はreq.customer.id。allowedSlugsと同じ注意点があるので
// docs/内部仕様_SNS連携.md参照）がfindDuplicateOwnerの重複判定に居座り続けて、
// 同じSNSアカウントを正しい持ち主が再連携しようとしてもduplicate_accountで
// ブロックされてしまう（2026-08-26、info@108teaworks.com/id: k22n7qwhimxで実機発生）。
//
// このcronは他のsrc/scripts/*.jsと同じ単発実行スクリプトで、cronから
// `docker compose run --rm sns-poster-orphan-sns-token-check` で日次起動する想定
// （実際のcrontab登録は手動実施。CLAUDE.md参照）。client_tokens.jsonの全キーについて
// customersレコードが実在するかmicroCMSに問い合わせ、存在しないキーが見つかったら
// ログに記録した上でメール通知する（自動削除はしない。誤検知時に実データを失うのを
// 避けるため、判断と削除は人間が行う）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { loadStore } = require("../lib/tokenStore");
const { getCustomerById } = require("../lib/customerStore");
const { notifyFailure } = require("../lib/mailer");
const { logInfo, logError } = require("../lib/logger").createLogger("orphan-sns-token-check.log");

async function main() {
  const store = loadStore();
  const slugs = Object.keys(store);
  logInfo(`[orphan-sns-token-check] ${slugs.length} slug(s) to check`);

  const orphans = [];
  for (const slug of slugs) {
    try {
      const customer = await getCustomerById(slug);
      if (!customer) {
        const platforms = Object.keys(store[slug]);
        orphans.push({ slug, platforms });
        logError(`[orphan-sns-token-check] orphaned slug=${slug} platforms=${platforms.join(",")}`);
      }
    } catch (err) {
      logError(`[orphan-sns-token-check] lookup failed slug=${slug}:`, err);
    }
  }

  if (orphans.length > 0) {
    const lines = orphans.map((o) => `- slug=${o.slug} platforms=${o.platforms.join(",")}`);
    await notifyFailure(
      "[edgeailab] 孤児化したSNS連携トークンを検知",
      [
        "json/client_tokens.jsonに、対応するcustomersレコードが存在しないキーが見つかりました。",
        "microCMS管理画面から顧客レコードを直接削除した場合にこの状態になります"
        + "（正規の解約導線ならトークンも連動して削除されるため発生しません）。",
        "",
        ...lines,
        "",
        "このまま放置すると、同じSNSアカウントを正しい持ち主が再連携しようとした際に",
        "duplicate_accountとして誤ってブロックされます。json/client_tokens.jsonから",
        "該当キーを削除するか、正しい顧客のslug（req.customer.id）にリネームしてください。",
      ].join("\n")
    ).catch((err) => logError("[orphan-sns-token-check] notifyFailure failed:", err));
  }

  logInfo(`[orphan-sns-token-check] done. orphans=${orphans.length} checked=${slugs.length}`);
}

main().catch((err) => {
  logError("[orphan-sns-token-check] fatal error:", err);
  process.exit(1);
});
