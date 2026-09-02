// アカウント解約（プロフィールメニュー「解約」）。
// customersレコードは削除せずstatusを"canceled"に変更するだけに留める
// （同一emailでの再サインアップ時にcustomerStore.reactivateCustomerで再利用するため）。
const express = require("express");
const customerStore = require("../lib/customerStore");
const { requireAuth } = require("../middleware/requireAuth");
const { clearSessionCookie } = require("../lib/jwt");
const { getConnectedEntry, deletePlatformTokensBySlug } = require("../lib/tokenStore");
const { getStripe } = require("../lib/stripeClient");
const { notifyFailure } = require("../lib/mailer");
const { listPendingByCustomer, deleteScheduledPost } = require("../lib/scheduledPostStore");
const { listSchedulesForCustomer, deleteSchedule } = require("../lib/scheduleStore");

const router = express.Router();

const PLATFORMS = ["facebook", "instagram", "threads", "x", "linkedin"];

function currentUserRole(user) {
  return Array.isArray(user.role) ? user.role[0] : user.role;
}

// 未実行（status=pending）の予約投稿をまとめて削除する。スケジュール投稿由来・
// ワンショット予約由来の両方を含む（listPendingByCustomer参照）。
// microCMSへの書き込みは並行数が多いと429（Too many requests）で弾かれるため
// （routes/schedules.jsのtexts/bulk作成時に実際に発生していた）、1件ずつ順番に削除する。
async function cancelScheduledJobsForCustomer(customerId) {
  const pending = await listPendingByCustomer(customerId);
  for (const post of pending) {
    await deleteScheduledPost(post.id);
  }
  return pending.length;
}

// 継続投稿の定義（post_schedules）自体を削除する。以前は「scheduleMaterializer.jsが
// customers.status="canceled"の顧客を生成対象から除外する（isCanceledガード）ため
// 削除不要」としていたが、これは同一customerIdでの再サインアップ（reactivateCustomer）
// を考慮しておらず、再登録して本契約が完了した瞬間にisCanceled/requiresPaymentRegistration
// ガードが外れ、解約前の古いスケジュール定義がそのまま生成・投稿を再開してしまう
// 実害のある不具合になっていた（2026-09-02発覚、biza3cp70で実機確認。解約前のスケジュールが
// 再登録後に実際に投稿まで進んでいた）。予約投稿と同じ理由で1件ずつ順番に削除する。
async function deleteSchedulesForCustomer(customerId) {
  const schedules = await listSchedulesForCustomer(customerId);
  for (const schedule of schedules) {
    await deleteSchedule(schedule.id);
  }
  return schedules.length;
}

router.post("/api/account/cancel", requireAuth, async (req, res) => {
  // アカウント全体（サブスクリプション・全メンバーのSNS連携）に影響する操作のため、
  // team.jsのメンバー招待と同様に管理者のみ実行できるようにする。
  if (currentUserRole(req.user) !== "管理者") {
    return res.status(403).json({ error: "forbidden", message: "解約はアカウント管理者のみ実行できます。" });
  }

  const customer = req.customer;

  try {
    const stripe = getStripe();

    if (customer.stripeSubscriptionId) {
      if (stripe) {
        try {
          // invoice_now: trueで、解約時点までにStripe Billing Meterへ報告済みだが
          // まだ請求書化されていない従量分（投稿数・Xサーチャージ）を最終請求書として
          // 即座に確定させる。指定しないと当期分の従量課金がそのまま切り捨てられ、
          // 一切請求されずに解約できてしまう（2026-09-02発覚、実際に投稿99件分の
          // meter eventが未請求のまま解約されたことをStripe側で確認）。
          // prorate: falseは基本料金（固定費）側の日割り調整をしないため
          // （基本料金は月初一括請求済みで日割り返金の対象外という既存の請求方針に合わせる）。
          await stripe.subscriptions.cancel(customer.stripeSubscriptionId, {
            invoice_now: true,
            prorate: false,
          });
        } catch (err) {
          console.error(
            `[account/cancel] Stripe subscription cancel failed customerId=${customer.id} subscriptionId=${customer.stripeSubscriptionId}:`,
            err
          );
          // Stripe側の失敗で解約導線全体を止めない（顧客からは解約済みに見えるべき）。
          // customers.statusの更新は継続し、運用側はこの通知メールを見て
          // Stripe管理画面で個別にサブスクリプションを解約する。
          await notifyFailure(
            "[edgeailab] 解約処理でStripe連携エラー",
            [
              `customerId: ${customer.id}`,
              `email: ${customer.email}`,
              `stripeSubscriptionId: ${customer.stripeSubscriptionId}`,
              `エラー: ${err.message}`,
              "",
              "customers.statusはcanceledに更新されますが、Stripe側のサブスクリプションが",
              "解約されずに残っています。Stripe管理画面で手動解約してください。",
            ].join("\n")
          );
        }
      } else {
        console.error(
          `[account/cancel] Stripe not configured, could not cancel subscription customerId=${customer.id}`
        );
        await notifyFailure(
          "[edgeailab] 解約処理でStripe連携エラー",
          [
            `customerId: ${customer.id}`,
            `email: ${customer.email}`,
            `stripeSubscriptionId: ${customer.stripeSubscriptionId}`,
            "エラー: STRIPE_SECRET_KEYが未設定のためStripe側のサブスクリプションを解約できませんでした。",
            "",
            "customers.statusはcanceledに更新されますが、Stripe側のサブスクリプションが",
            "解約されずに残っています。Stripe管理画面で手動解約してください。",
          ].join("\n")
        );
      }
    }

    // 解約後もStripe Customerにカードが残り続けないよう、登録済みの
    // カード情報（PaymentMethod）をすべてdetachする（FAQ「解約した場合は
    // 自動的にカード情報は削除されます」の実体）。
    if (customer.stripeCustomerId) {
      if (stripe) {
        try {
          const cards = await stripe.paymentMethods.list({ customer: customer.stripeCustomerId, type: "card" });
          for (const pm of cards.data) {
            await stripe.paymentMethods.detach(pm.id);
          }
        } catch (err) {
          console.error(
            `[account/cancel] failed to detach cards customerId=${customer.id} stripeCustomerId=${customer.stripeCustomerId}:`,
            err
          );
          await notifyFailure(
            "[edgeailab] 解約処理でStripe連携エラー",
            [
              `customerId: ${customer.id}`,
              `email: ${customer.email}`,
              `stripeCustomerId: ${customer.stripeCustomerId}`,
              `エラー: ${err.message}`,
              "",
              "customers.statusはcanceledに更新されますが、Stripe側のカード情報が",
              "削除されずに残っています。Stripe管理画面で手動削除してください。",
            ].join("\n")
          );
        }
      } else {
        console.error(
          `[account/cancel] Stripe not configured, could not detach cards customerId=${customer.id}`
        );
      }
    }

    const entry = getConnectedEntry(customer.id);
    for (const platform of PLATFORMS) {
      if (entry[platform]) {
        deletePlatformTokensBySlug(customer.id, platform);
      }
    }

    const canceledScheduledPostCount = await cancelScheduledJobsForCustomer(customer.id);
    console.info(`[account/cancel] canceled pending scheduled posts customerId=${customer.id} count=${canceledScheduledPostCount}`);

    const deletedScheduleCount = await deleteSchedulesForCustomer(customer.id);
    console.info(`[account/cancel] deleted post_schedules customerId=${customer.id} count=${deletedScheduleCount}`);

    // clearSessionCookieはブラウザにCookie削除を指示するだけでJWT自体は失効させないため、
    // resetPassword/changePasswordと同様にusers[].sessionVersionを全員分インクリメントし、
    // 発行済みの全セッション（本人・招待メンバー全員、他デバイス・他ブラウザ含む）を
    // サーバー側でも無効化する。これが無いと、解約後も既存のセッショントークンを
    // 使い回すことで認証済みAPIを叩き続けられてしまう。
    const invalidatedUsers = (customer.users || []).map((u) => ({
      ...u,
      sessionVersion: (Number(u.sessionVersion) || 0) + 1,
    }));
    await customerStore.updateCustomer(customer.id, {
      status: ["canceled"],
      users: invalidatedUsers,
    });

    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[account/cancel] failed customerId=${customer.id}:`, err);
    res.status(500).json({ error: "internal_error", message: "解約処理に失敗しました。しばらくしてから再度お試しください。" });
  }
});

module.exports = router;
