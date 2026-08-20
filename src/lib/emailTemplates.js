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

const REFERRAL_INVITATION_EMAIL = {
  subject: (referrerName) => `【EdgeAI Lab】${referrerName}様からsns-posterへのご招待です`,
  body: (referrerName, signupUrl) =>
    [
      `${referrerName}様より、EdgeAI Lab（sns-poster）へのご招待が届いています。`,
      "",
      "sns-posterは、X・Threads・Facebook・InstagramへのSNS投稿を",
      "AIが文案・画像/動画から自動生成し、スケジュール投稿・一括管理できる",
      "SaaSサービスです。",
      "",
      "以下のリンクから新規登録が行えます。",
      signupUrl,
      "",
      "このリンクの有効期限は10日間です。",
      "心当たりがない場合は、本メールを破棄してください。",
    ].join("\n"),
};

const PASSWORD_RESET_EMAIL = {
  subject: "【EdgeAI Lab】パスワード再設定のご案内",
  body: (resetUrl) =>
    [
      "パスワード再設定のリクエストを受け付けました。",
      "",
      "以下のリンクから新しいパスワードを設定してください。",
      resetUrl,
      "",
      "このリンクの有効期限は1時間です。",
      "心当たりがない場合は、本メールを破棄してください（パスワードは変更されません）。",
    ].join("\n"),
};

module.exports = {
  VERIFICATION_EMAIL,
  TRIAL_ENDING_EMAIL,
  INVITATION_EMAIL,
  REFERRAL_INVITATION_EMAIL,
  PASSWORD_RESET_EMAIL,
  planLabel,
};
