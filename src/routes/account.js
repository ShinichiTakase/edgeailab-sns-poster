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
const { listAllScheduledPostsForCustomer, deleteScheduledPost } = require("../lib/scheduledPostStore");
const { listSchedulesForCustomer, deleteSchedule } = require("../lib/scheduleStore");
const { listScheduleTexts, deleteScheduleText } = require("../lib/scheduleTextStore");
const { listAllPostingLogsForCustomer, deletePostingLog } = require("../lib/postingLogStore");

const router = express.Router();

const PLATFORMS = ["facebook", "instagram", "threads", "x", "linkedin"];

function currentUserRole(user) {
  return Array.isArray(user.role) ? user.role[0] : user.role;
}

// 予約投稿（scheduled_posts）を全件削除する。以前はstatus=pending分のみ削除し、
// done/failed（投稿一覧・請求内訳計算用の実績履歴）は残す設計だったが、解約は
// 顧客データの物理削除として扱うべきという方針に変更したため全件削除に変更した
// （2026-09-02。post-list.htmlの投稿一覧・billing-history.htmlの請求内訳表示は
// いずれも解約後はcustomersレコードごと消えてログイン自体できなくなるため、
// 履歴を残す実利はない）。スケジュール投稿由来・ワンショット予約由来の両方を含む。
// microCMSへの書き込みは並行数が多いと429（Too many requests）で弾かれるため
// （routes/schedules.jsのtexts/bulk作成時に実際に発生していた）、1件ずつ順番に削除する。
async function deleteAllScheduledPostsForCustomer(customerId) {
  const posts = await listAllScheduledPostsForCustomer(customerId);
  for (const post of posts) {
    await deleteScheduledPost(post.id);
  }
  return posts.length;
}

// 投稿済みログ（posting_logs）を全件削除する（2026-09-02追加。理由は
// deleteAllScheduledPostsForCustomer参照）。
async function deletePostingLogsForCustomer(customerId) {
  const logs = await listAllPostingLogsForCustomer(customerId);
  for (const log of logs) {
    await deletePostingLog(log.id);
  }
  return logs.length;
}

// 継続投稿の定義（post_schedules）と、それに紐づく投稿文章（schedule_texts。
// schedule_id経由でのみ辿れるためpost_schedulesを起点に列挙する）を削除する。
// 以前はpost_schedules自体を削除・一時停止していなかったが、これは同一customerIdでの
// 再サインアップ（reactivateCustomer）を考慮しておらず、再登録して本契約が完了した瞬間に
// isCanceled/requiresPaymentRegistrationガードが外れ、解約前の古いスケジュール定義が
// そのまま生成・投稿を再開してしまう実害のある不具合になっていた（2026-09-02発覚、
// biza3cp70で実機確認。解約前のスケジュールが再登録後に実際に投稿まで進んでいた）。
// 同じ理由で1件ずつ順番に削除する。
async function deleteSchedulesForCustomer(customerId) {
  const schedules = await listSchedulesForCustomer(customerId);
  let deletedTextCount = 0;
  for (const schedule of schedules) {
    const texts = await listScheduleTexts(schedule.id);
    for (const text of texts) {
      await deleteScheduleText(text.id);
      deletedTextCount += 1;
    }
    await deleteSchedule(schedule.id);
  }
  return { scheduleCount: schedules.length, textCount: deletedTextCount };
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
          const canceledSubscription = await stripe.subscriptions.cancel(customer.stripeSubscriptionId, {
            invoice_now: true,
            prorate: false,
          });

          // invoice_now: trueは最終請求書を"draft"状態で作るだけで、自動では
          // finalize（draft→open）も決済も行わない（Stripeはauto_advance:trueの
          // draft請求書を既定で作成の約1時間後に自動finalizeするが、それでは解約と
          // 同時に課金されない）。finalizeInvoiceで即座にopenへ進める（2026-09-02発覚、
          // 実際に作成されたdraft請求書が未決済のまま残っていたことをStripe側で確認。
          // カードdetachより前に実行するため、この時点ではまだカードが有効）。
          //
          // finalizeInvoice自体がcollection_method:charge_automaticallyの請求書に対して
          // 即座に自動決済を試みるため、有効な支払い方法があればこの時点で既にstatus:"paid"
          // かつamount_paid===totalになっている（その場合、後続のinvoices.payを呼ぶと
          // "Invoice is already paid"エラーになるため呼ばない）。一方、支払い方法が
          // 無い顧客（解約前にpayment.htmlで唯一のカードを削除していた等）の場合、
          // Stripeは実際の課金を試みずamount_paid:0のままstatus:"paid"にしてしまうことが
          // 実機で確認された（顧客残高への計上のみで、次回請求書が発生しない解約後は
          // 実質的に回収不能になる）。amount_paid<totalを「実際には課金されていない」と
          // 判定し、その場合のみinvoices.payで明示的な決済を試みる。それでも
          // amount_paid<totalのままなら（支払い方法が無い等で決済不能）例外を投げて
          // notifyFailureへ通知する。
          if (canceledSubscription.latest_invoice) {
            const invoiceId = canceledSubscription.latest_invoice;
            try {
              let invoice = await stripe.invoices.finalizeInvoice(invoiceId);
              if (invoice.amount_paid < invoice.total) {
                invoice = await stripe.invoices.pay(invoiceId);
              }
              if (invoice.amount_paid < invoice.total) {
                throw new Error(
                  `invoice not fully collected: status=${invoice.status} amount_paid=${invoice.amount_paid} total=${invoice.total}`
                );
              }
            } catch (invoiceErr) {
              console.error(
                `[account/cancel] final invoice finalize/pay failed customerId=${customer.id} invoiceId=${invoiceId}:`,
                invoiceErr
              );
              await notifyFailure(
                "[edgeailab] 解約処理で最終請求書の決済エラー",
                [
                  `customerId: ${customer.id}`,
                  `email: ${customer.email}`,
                  `invoiceId: ${invoiceId}`,
                  `エラー: ${invoiceErr.message}`,
                  "",
                  "サブスクリプション自体は解約済みですが、解約時点までの従量料金を含む",
                  "最終請求書の決済が完了していません（カード拒否、または解約時点で",
                  "有効な支払い方法が登録されていなかった等）。Stripe管理画面で個別に",
                  "請求書の状態を確認し、必要に応じて顧客に連絡のうえ手動決済してください。",
                ].join("\n")
              );
            }
          }
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

    // カード情報（PaymentMethod）のdetachは、解約直後ではなく解約から23:30後に
    // scripts/canceledCardCleanup.js（cron）で行う（2026-09-02変更。それまでは
    // ここで即時detachしていたが、直前の最終請求書決済（invoice_now: true→
    // finalizeInvoice→pay）が何らかの理由で完了していない場合に備え、Stripe側の
    // 自動リトライ等が完了する猶予を持たせるため。詳細はcustomerStore.js の
    // isPastCardDeletionDelay・CARD_DELETION_DELAY_MS参照）。FAQ「解約した場合は
    // 自動的にカード情報は削除されます」自体は変わらず成立する（タイミングが
    // 遅延するだけ）。

    const entry = getConnectedEntry(customer.id);
    for (const platform of PLATFORMS) {
      if (entry[platform]) {
        deletePlatformTokensBySlug(customer.id, platform);
      }
    }

    // 招待メンバー（編集者・承認者・閲覧者等）のusersエントリ自体を削除する
    // （2026-09-02追加。それまでは残っていた）。requireAuth.jsはcustomer.usersから
    // userIdでfindしてヒットしなければ401にするため、エントリを削除すること自体が
    // 即座かつ確実なセッション無効化になる（sessionVersionのインクリメント以上に
    // 強い無効化）。解約を実行した管理者本人のエントリのみ残し、sessionVersionを
    // インクリメントする（clearSessionCookieはブラウザにCookie削除を指示するだけで
    // JWT自体は失効させないため、この処理が無いと解約後も既存のセッショントークンを
    // 使い回すことで認証済みAPIを叩き続けられてしまう）。
    const cancelingUser = (customer.users || []).find((u) => u.userId === req.user.userId);
    const remainingUsers = cancelingUser
      ? [{ ...cancelingUser, sessionVersion: (Number(cancelingUser.sessionVersion) || 0) + 1 }]
      : [];
    // canceledAt: 24時間の再登録ロック（customerStore.isWithinCancellationLock、
    // auth.js参照）とカード削除の23:30遅延（isPastCardDeletionDelay、
    // scripts/canceledCardCleanup.js参照）の両方の起点。2026-09-02追加。
    // 同一メールで再サインアップした場合、reactivateCustomerがusersを新しい管理者
    // 1名のみで丸ごと上書きするため（既存実装）、招待メンバーが残っていた場合でも
    // 再登録後は自動的にクリーンな状態になる。
    await customerStore.updateCustomer(customer.id, {
      status: ["canceled"],
      users: remainingUsers,
      canceledAt: new Date().toISOString(),
    });

    clearSessionCookie(res);
    res.json({ ok: true });

    // ここから先（投稿一覧・スケジュール定義の全件物理削除）はレスポンス送出後に
    // バックグラウンドで実行する。microCMSへの429対策で1件ずつ順番にDELETEするため、
    // 履歴の多い顧客（実機ではscheduled_posts 387件・posting_logs 395件・
    // schedule_texts 70件で合計3分超）だとnginx-proxyのタイムアウトを超えてしまい、
    // 実際には解約処理自体（Stripe解約・最終請求書決済・SNSトークン削除・セッション無効化・
    // status更新）は完了しているのに、クライアントには「解約処理に失敗しました」という
    // 誤ったエラー表示になっていた（2026-09-02発覚、shin.takase@icloud.comの実解約で
    // 確認。処理自体は約3分後にバックグラウンドで正常完了していた）。この時点で
    // status=canceledかつSNSトークンも削除済みで実害のあるガードは既にかかっているため、
    // 以降の履歴削除に多少時間がかかっても顧客体験上は問題ない。
    (async () => {
      try {
        const deletedScheduledPostCount = await deleteAllScheduledPostsForCustomer(customer.id);
        console.info(`[account/cancel] deleted scheduled posts customerId=${customer.id} count=${deletedScheduledPostCount}`);

        const deletedPostingLogCount = await deletePostingLogsForCustomer(customer.id);
        console.info(`[account/cancel] deleted posting logs customerId=${customer.id} count=${deletedPostingLogCount}`);

        const { scheduleCount: deletedScheduleCount, textCount: deletedScheduleTextCount } =
          await deleteSchedulesForCustomer(customer.id);
        console.info(
          `[account/cancel] deleted post_schedules customerId=${customer.id} scheduleCount=${deletedScheduleCount} textCount=${deletedScheduleTextCount}`
        );
      } catch (err) {
        console.error(`[account/cancel] background history cleanup failed customerId=${customer.id}:`, err);
        await notifyFailure(
          "[edgeailab] 解約処理の後片付け（投稿一覧・スケジュール削除）でエラー",
          [
            `customerId: ${customer.id}`,
            `email: ${customer.email}`,
            `エラー: ${err.message}`,
            "",
            "解約自体（Stripe解約・最終請求書決済・SNSトークン削除・セッション無効化・",
            "status更新）は完了済みですが、投稿一覧・スケジュール定義の削除が途中で",
            "失敗した可能性があります。必要に応じてmicroCMS管理画面で手動確認してください。",
          ].join("\n")
        ).catch(() => {});
      }
    })();
  } catch (err) {
    console.error(`[account/cancel] failed customerId=${customer.id}:`, err);
    res.status(500).json({ error: "internal_error", message: "解約処理に失敗しました。しばらくしてから再度お試しください。" });
  }
});

module.exports = router;
