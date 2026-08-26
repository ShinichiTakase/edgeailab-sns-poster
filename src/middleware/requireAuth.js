// Cookie内のJWTを検証し、有効なら req.customer にmicroCMSの顧客レコードをセットする。
// cookie-parser等の追加依存を避け、Cookieヘッダーを直接パースする。
const { COOKIE_NAME, verifySession } = require("../lib/jwt");
const {
  getCustomerById,
  requiresPaymentRegistration,
  isTrialPostLimitReached,
  isCanceled,
  roleOf,
  TRIAL_POST_LIMIT,
} = require("../lib/customerStore");
const { activateAfterTrialLimitIfNeeded, sendTrialPostLimitReachedEmailIfNeeded } = require("../lib/trialLimitAutoActivation");

function parseCookieHeader(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function readSessionToken(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

async function requireAuth(req, res, next) {
  const token = readSessionToken(req);
  const payload = token && verifySession(token);
  if (!payload) {
    return res.status(401).json({ error: "unauthenticated" });
  }
  try {
    const customer = await getCustomerById(payload.sub);
    if (!customer) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const user = (customer.users || []).find((u) => u.userId === payload.userId);
    if (!user) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    // パスワード再設定でsessionVersionがインクリメントされていたら、
    // このJWTは旧セッションとして無効（全セッション無効化の実現手段）。
    if ((payload.sessionVersion || 0) !== (user.sessionVersion || 0)) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    req.customer = customer;
    req.user = user;
    next();
  } catch (err) {
    console.error("[requireAuth] failed to load customer:", err);
    res.status(500).json({ error: "internal_error" });
  }
}

// requireAuthの後段に挟んで使う。メール未認証のアカウントで
// SNS実投稿・メンバー招待送信など「実害のある操作」をブロックするためのガード。
// フロント側のボタン非活性化と対で、サーバー側の必須チェックとして機能する。
function requireVerified(req, res, next) {
  if (!req.customer || !req.customer.isVerified) {
    return res.status(403).json({ error: "email_not_verified", message: "メール認証が完了していません" });
  }
  next();
}

// requireAuthの後段に挟んで使う。トライアル終了後、または解約後の再登録直後
// （customers.status:"active"だが未決済。customerStore.reactivateCustomer参照）で
// 支払い情報未登録のまま利用を続けようとした場合にカード登録画面へ誘導する。
// 名前はblockExpiredTrialのままだが、判定本体（requiresPaymentRegistration）は
// トライアル経過済みだけでなく「トライアルを経由しない再登録」も対象にする。
// reasonクエリはトライアル経由か否かで出し分け、upgrade.html側の案内文を
// 実態に合わせる（トライアルを一度も経ていない再登録者に「トライアル期間が
// 終了しているため」と表示すると事実と異なるため）。
function blockExpiredTrial(req, res, next) {
  if (requiresPaymentRegistration(req.customer)) {
    const status = Array.isArray(req.customer.status) ? req.customer.status[0] : req.customer.status;
    const reason = status === "trial" ? "trial_expired" : "payment_required";
    return res.redirect(`/upgrade.html?reason=${reason}`);
  }
  next();
}

// requireAuth・requireVerified と並べて組み込むミドルウェア。トライアル中
// （status: trial）に限り、全SNS合計の投稿数がcustomerStore.TRIAL_POST_LIMIT
// （60通）に達した時点で以降の投稿をブロックする。判定本体はcustomerStore.js の
// isTrialPostLimitReached（req/resに依存しない純粋関数。cronからも同じ判定を使う）。
//
// 2026-08-25変更: ブロックする直前に、支払い方法（Stripeカード）が登録済みなら
// その場で自動アクティベート（trialLimitAutoActivation.js）を試みる。60通到達時点
// では未登録だったが、その後payment.htmlでカードだけ登録しておいた顧客が「次に
// 投稿しようとしたタイミング」で自動的に本契約へ切り替わり投稿が再開されるように
// するための救済経路（60通到達の瞬間に登録済みだった場合の即時アクティベートは、
// posts.js側のcrossedTrialPostLimit判定で別途行われる。こちらはその取りこぼし
// ケースを拾うための、ブロック直前での再チェック）。
async function requireUnderTrialPostLimit(req, res, next) {
  if (!isTrialPostLimitReached(req.customer)) {
    return next();
  }

  const result = await activateAfterTrialLimitIfNeeded({
    customer: req.customer,
    logger: { logError: (...args) => console.error(...args) },
  });
  if (result === "activated") {
    req.customer.status = ["active"];
    // 60通到達の瞬間ではなく、事後にカードを登録して初めてここで救済された場合も
    // 同じ通知メールを送る（posts.js側のcrossedTrialPostLimit経路と同じ文面。
    // "no_payment_method"はここでは送らない。ブロックされ続けている顧客が投稿を
    // 試みるたびに送られてしまうため）。
    await sendTrialPostLimitReachedEmailIfNeeded({
      customer: req.customer,
      result,
      logger: { logError: (...args) => console.error(...args) },
    });
    return next();
  }

  return res.status(403).json({
    error: "trial_post_limit_reached",
    message: `トライアル中の投稿上限（${TRIAL_POST_LIMIT}通）に達しました`,
  });
}

// requireAuth・requireVerified・requireUnderTrialPostLimit と並べて組み込む
// ミドルウェア。ワンショット投稿・継続投稿の実行部分は必ずこのガードを組み込むこと。
// 解約時にcustomer.statusをcanceledへ変更する処理（routes/account.js）と、
// 解約時に予約投稿・cronを削除する処理（同ファイルのcancelScheduledJobsForCustomer、
// 現状は雛形）の実装漏れに対する保険であり、両方が働いても問題ない。
// 判定本体はcustomerStore.js の isCanceled（req/resに依存しない純粋関数。
// cronからも同じ判定を使う）。
function blockCanceledCustomer(req, res, next) {
  if (isCanceled(req.customer)) {
    return res.status(403).json({ error: "account_canceled", message: "このアカウントは解約済みです" });
  }
  next();
}

// requireAuthの後段に挟んで使う。閲覧者ロールは投稿・スケジュール編集・AI生成・
// アップロード・SNS連携解除など「実害のある書き込み操作」を一切行えない設計とする
// （2026-08-22時点まで、閲覧者ロールにはこの制限が一切実装されておらず、実質的に
// 管理者と同じ操作ができてしまっていた。書き込み系エンドポイントには必ずこれを挟むこと）。
function blockViewerRole(req, res, next) {
  if (roleOf(req.user) === "閲覧者") {
    return res.status(403).json({ error: "forbidden", message: "閲覧者権限ではこの操作はできません" });
  }
  next();
}

// blockViewerRoleのJSON 403版はfetch経由のAPI向け。/oauth/*/startはブラウザの
// 直接ナビゲーション（<a href>クリック）で叩かれるGETルートのため、blockExpiredTrialや
// requireSnsConnectionAvailableと同じ「生JSONを画面に出さずredirectする」流儀に合わせる。
function blockViewerRoleRedirect(req, res, next) {
  if (roleOf(req.user) === "閲覧者") {
    return res.redirect("/onboarding.html");
  }
  next();
}

module.exports = {
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  requireUnderTrialPostLimit,
  blockCanceledCustomer,
  blockViewerRole,
  blockViewerRoleRedirect,
  readSessionToken,
  parseCookieHeader,
};
