// AI文案生成（ラウンドロビン投稿用バリエーション、Instagramリール動画のスロット数を含む）で
// 一度に生成する候補数の単一情報源。環境変数DOCS_NUMBERから読み込む
//（コスト調整・A/Bテストのため、コード変更なしに調整できるようにしている）。
//
// 設計メモ: 現状はプラットフォーム共通の1変数。将来プラットフォームごとに候補数を
// 分けたくなった場合は、この関数にplatform引数を追加し、
// DOCS_NUMBER_X / DOCS_NUMBER_THREADS 等の個別環境変数（未設定ならDOCS_NUMBERへ
// フォールバック）を読む形に拡張すると、既存呼び出し元（getDocsNumber()を引数なしで
// 呼んでいる箇所）への影響を抑えつつ拡張できる。
const DEFAULT_DOCS_NUMBER = 5;

let cachedValue = null;

function getDocsNumber() {
  if (cachedValue !== null) return cachedValue;

  const raw = process.env.DOCS_NUMBER;
  if (raw === undefined || raw.trim() === "") {
    cachedValue = DEFAULT_DOCS_NUMBER;
    return cachedValue;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[generationConfig] invalid DOCS_NUMBER="${raw}"（正の整数である必要があります）。` +
        `デフォルト値${DEFAULT_DOCS_NUMBER}にフォールバックします。`
    );
    cachedValue = DEFAULT_DOCS_NUMBER;
    return cachedValue;
  }

  cachedValue = parsed;
  return cachedValue;
}

module.exports = { getDocsNumber, DEFAULT_DOCS_NUMBER };
