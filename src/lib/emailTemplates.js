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

const TRIAL_POST_LIMIT_WARNING_EMAIL = {
  subject: "【EdgeAI Lab】無料トライアルの投稿数が上限に近づいています",
  body: (postCount, postLimit, upgradeUrl, plan) =>
    [
      `無料トライアル期間中の投稿数が、上限（${postLimit}通）の80%（${postCount}通）に達しました。`,
      `選択プラン: ${planLabel(plan)}`,
      "",
      `上限の${postLimit}通に達すると、それ以降の投稿ができなくなります。`,
      "トライアル期間中も引き続き投稿をご利用いただくには、お支払い情報のご登録が必要です。",
      "以下のリンクからお手続きください。",
      upgradeUrl,
      "",
      "ご不明な点がございましたら、サポートまでお問い合わせください。",
    ].join("\n"),
};

const BACKUP_CARD_CHARGED_EMAIL = {
  subject: "【EdgeAI Lab】お支払い（バックアップカード利用）のお知らせ",
  body: (invoiceUrl) =>
    [
      "登録済みのお支払い方法（プライマリカード）でのお支払いに失敗したため、",
      "登録済みのバックアップカードでお支払い処理を行い、正常に完了しました。",
      "",
      "プライマリカードの有効期限切れ・利用限度額超過等が原因の可能性があります。",
      "お支払い方法ページから、プライマリカードの登録し直しをご検討ください。",
      invoiceUrl ? `\n請求内容: ${invoiceUrl}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
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

const APPROVAL_REQUEST_EMAIL = {
  subject: "【EdgeAI Lab】投稿の承認依頼が届いています",
  body: (requesterName, summary, approvalUrl) =>
    [
      `${requesterName || "編集者"}様から投稿の承認依頼が届いています。`,
      "",
      summary,
      "",
      "以下のリンクから内容を確認し、承認または却下してください。",
      approvalUrl,
      "",
      "このリンクの有効期限は72時間です。",
      "期限が切れた場合は、ログイン後メニューの「承認待ち一覧」からご確認いただけます。",
    ].join("\n"),
};

const APPROVAL_DECIDED_EMAIL = {
  subject: (decision) => `【EdgeAI Lab】投稿の承認依頼が${decision === "rejected" ? "却下" : "失効"}されました`,
  body: (decision, summary, comment) =>
    [
      decision === "rejected" ? "承認依頼が却下されました。" : "承認依頼が72時間以内に承認されず、失効しました。",
      "",
      summary,
      comment ? `\nコメント: ${comment}` : "",
      "",
      "内容を編集の上、再度承認依頼を送信してください。",
    ]
      .filter(Boolean)
      .join("\n"),
};

const SCHEDULED_POST_RESULT_EMAIL = {
  subject: (success) => `【EdgeAI Lab】予約投稿が${success ? "完了しました" : "失敗しました"}`,
  body: (scheduleName, platformLabel, content, success) =>
    [
      `スケジュール「${scheduleName}」の予約投稿が${success ? "正常に完了しました" : "失敗しました"}。`,
      "",
      `投稿先: ${platformLabel}`,
      "投稿内容:",
      content || "(内容なし)",
      ...(success
        ? []
        : ["", "自動で再試行を行いましたが、投稿できませんでした。内容をご確認のうえ、必要に応じてスケジュール設定を見直してください。"]),
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
  TRIAL_POST_LIMIT_WARNING_EMAIL,
  BACKUP_CARD_CHARGED_EMAIL,
  INVITATION_EMAIL,
  APPROVAL_REQUEST_EMAIL,
  APPROVAL_DECIDED_EMAIL,
  SCHEDULED_POST_RESULT_EMAIL,
  PASSWORD_RESET_EMAIL,
  planLabel,
};
