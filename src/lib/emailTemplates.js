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
  // hasPaymentMethod: お支払い方法（Stripeカード）を登録済みかどうかで、上限到達時の
  // 案内内容を出し分ける（2026-08-25変更。上限（60通）到達時、未登録なら投稿停止・
  // 登録済みなら登録済みカードへ自動的に課金が開始される仕様のため）。
  body: (postCount, postLimit, paymentUrl, plan, hasPaymentMethod) =>
    [
      `無料トライアル期間中の投稿数が、上限（${postLimit}通）の80%（${postCount}通）に達しました。`,
      `選択プラン: ${planLabel(plan)}`,
      "",
      ...(hasPaymentMethod
        ? [
            `上限の${postLimit}通に達すると、登録済みのお支払い方法（クレジットカード）へ自動的に基本料金のご請求が開始され、引き続き投稿をご利用いただけます。`,
          ]
        : [
            `上限の${postLimit}通に達すると、それ以降の投稿ができなくなります。`,
            "トライアル期間中も引き続き投稿をご利用いただくには、お支払い情報のご登録が必要です。",
            "以下のリンクからお手続きください。",
            paymentUrl,
          ]),
      "",
      "ご不明な点がございましたら、サポートまでお問い合わせください。",
    ].join("\n"),
};

// トライアル投稿上限（60通）そのものに達した瞬間に送る通知（2026-08-25追加）。
// activated: trialLimitAutoActivation.jsが実際に本契約へ自動切り替えできたかどうか
// （支払い方法登録済みでStripeサブスクリプション作成・課金に成功した場合のみtrue）。
const TRIAL_POST_LIMIT_REACHED_EMAIL = {
  subject: (activated) =>
    activated
      ? "【EdgeAI Lab】無料トライアルの投稿上限に達し、本契約へ切り替わりました"
      : "【EdgeAI Lab】無料トライアルの投稿上限に達しました",
  body: (postLimit, paymentUrl, plan, activated) =>
    [
      `無料トライアル期間中の投稿数が、上限（${postLimit}通）に達しました。`,
      `選択プラン: ${planLabel(plan)}`,
      "",
      ...(activated
        ? [
            "登録済みのお支払い方法へ基本料金のご請求を行い、本契約へ自動的に切り替わりました。",
            "引き続き投稿をご利用いただけます。",
          ]
        : [
            "これ以降の投稿はできません。",
            "引き続き投稿をご利用いただくには、お支払い情報のご登録が必要です。",
            "以下のリンクからお手続きください。",
            paymentUrl,
          ]),
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

const PAYMENT_SUCCEEDED_EMAIL = {
  subject: "【EdgeAI Lab】ご請求のお知らせ",
  body: (amount, invoiceUrl) =>
    [
      `今回のご請求金額は ${amount.toLocaleString()}円 で、登録済みのお支払い方法にて決済が完了しました。`,
      "",
      "内訳の詳細は、請求情報ページまたは以下の請求書リンクからご確認いただけます。",
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

// ワンショット投稿（即時投稿・予約投稿の一括登録、編集者の承認経由分を含む）専用の
// 完了通知。SCHEDULED_POST_RESULT_EMAILはスケジュール名（post_schedules.name）を
// 前提とした文面のため、スケジュールに紐付かないワンショット投稿には流用できず
// 別テンプレートとして新設した。
const ONE_SHOT_POST_RESULT_EMAIL = {
  subject: (success) => `【EdgeAI Lab】ワンショット投稿が${success ? "完了しました" : "失敗しました"}`,
  body: (platformLabel, content, success) =>
    [
      `ワンショット投稿が${success ? "正常に完了しました" : "失敗しました"}。`,
      "",
      `投稿先: ${platformLabel}`,
      "投稿内容:",
      content || "(内容なし)",
      ...(success
        ? []
        : ["", "自動で再試行を行いましたが、投稿できませんでした。内容をご確認のうえ、再度投稿をお試しください。"]),
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

// 管理者ダッシュボード「パスワード初期化」用。自分でパスワード再設定ができない
// ユーザー向けに、運営側が新しいパスワードを直接発行してメールで案内する
// （PASSWORD_RESET_EMAILのようなトークン付きリンクではなく、パスワードそのものを
// 本文に記載する。ログイン後の変更はchange-password.htmlから可能）。
const ADMIN_PASSWORD_RESET_EMAIL = {
  subject: "【EdgeAI Lab】パスワードが初期化されました",
  body: (newPassword) =>
    [
      "運営者によりパスワードが初期化されました。",
      "",
      "新しいパスワード:",
      newPassword,
      "",
      "ログイン後、お手数ですがパスワード変更画面から新しいパスワードに変更してください。",
      "心当たりがない場合は、お手数ですがサポートまでご連絡ください。",
    ].join("\n"),
};

module.exports = {
  VERIFICATION_EMAIL,
  TRIAL_ENDING_EMAIL,
  TRIAL_POST_LIMIT_WARNING_EMAIL,
  TRIAL_POST_LIMIT_REACHED_EMAIL,
  BACKUP_CARD_CHARGED_EMAIL,
  PAYMENT_SUCCEEDED_EMAIL,
  INVITATION_EMAIL,
  APPROVAL_REQUEST_EMAIL,
  APPROVAL_DECIDED_EMAIL,
  SCHEDULED_POST_RESULT_EMAIL,
  ONE_SHOT_POST_RESULT_EMAIL,
  PASSWORD_RESET_EMAIL,
  ADMIN_PASSWORD_RESET_EMAIL,
  planLabel,
};
