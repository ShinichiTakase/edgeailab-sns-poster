// 顧客向けメールの件名・本文テンプレート。
// 108teaworks/next-app/lib/emailClientTexts.ts と同じ「関数で本文を組み立てる」パターン。

const PLAN_LABELS = { basic: "Basic", standard: "Standard", advanced: "Advanced" };

function planLabel(plan) {
  return PLAN_LABELS[plan] || plan;
}

const VERIFICATION_EMAIL = {
  subject: "【EdgeAI Lab】メールアドレスの確認をお願いします",
  body: (verifyUrl, plan) =>
    [
      "この度はEdgeAI Lab（sns-poster）にお申し込みいただきありがとうございます。",
      `選択プラン: ${planLabel(plan)}`,
      "",
      "以下のリンクをクリックして、メールアドレスの確認を完了してください。",
      verifyUrl,
      "",
      "このリンクの有効期限は24時間です。",
      "心当たりがない場合は、本メールを破棄してください。",
    ].join("\n"),
};

const TRIAL_ENDING_EMAIL = {
  subject: "【EdgeAI Lab】無料トライアルがまもなく終了します",
  body: (daysLeft, upgradeUrl, plan) =>
    [
      `無料トライアルの残り日数はあと${daysLeft}日です。`,
      `選択プラン: ${planLabel(plan)}`,
      "",
      "トライアル終了後もサービスをご利用いただくには、お支払い情報のご登録が必要です。",
      "以下のリンクからお手続きください。",
      upgradeUrl,
      "",
      "ご不明な点がございましたら、サポートまでお問い合わせください。",
    ].join("\n"),
};

const INVITATION_EMAIL = {
  subject: "【EdgeAI Lab】メンバー招待のお知らせ",
  body: (companyName, acceptUrl) =>
    [
      `${companyName ? `${companyName}様のチーム` : "EdgeAI Lab"}のワークスペースに招待されました。`,
      "",
      "以下のリンクからパスワードを設定し、招待を承諾してください。",
      acceptUrl,
      "",
      "このリンクの有効期限は7日間です。",
      "心当たりがない場合は、本メールを破棄してください。",
    ].join("\n"),
};

module.exports = { VERIFICATION_EMAIL, TRIAL_ENDING_EMAIL, INVITATION_EMAIL, planLabel };
