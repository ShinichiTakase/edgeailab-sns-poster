// 投稿失敗を顧客向け「お知らせ」として記録する。呼び出しは「最終的に失敗が確定した
// 時点」のみを対象とする想定（予約投稿は3回の自動再試行を打ち止めた時。ワンショット
// 投稿は再試行が無いため実行時の失敗＝即最終結果）。再試行中の一時失敗では呼ばないこと。
const { createAnnouncement } = require("./announcementStore");

const PLATFORM_DISPLAY_LABELS = { x: "X", threads: "Threads", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

// ポスターモジュール（xPoster.js等）はSNS APIの生エラー応答をそのまま
// `${何か}: ${JSON.stringify(json)}` の形でErrorのmessageに埋め込む。JSON部分だけを
// 取り出せればそれを、取り出せなければmessage全体をそのまま表示する。
function extractErrorDetail(err) {
  const message = (err && err.message) || String(err);
  const jsonStart = message.indexOf("{");
  if (jsonStart !== -1) {
    const jsonPart = message.slice(jsonStart);
    try {
      JSON.parse(jsonPart);
      return jsonPart;
    } catch (e) {
      // JSONとして解釈できない場合はmessage全体にフォールバックする。
    }
  }
  return message;
}

/**
 * @param {object} customer req.customer相当（idがcustomerCode）
 * @param {string} platform "x" | "threads" | "facebook" | "instagram" | "linkedin"
 * @param {string} content 投稿本文
 * @param {Error} err 投稿失敗時にthrowされたエラー
 * @param {string|null} scheduleName 予約投稿由来の場合のスケジュール名。ワンショット投稿はnull
 * @param {string} createdBy 投稿を実行しようとしたユーザーid（管理者ダッシュボード
 *   「投稿一覧」がpostingLogStore.createPostingLogのcreated_byと同じ意味で使う）
 */
function announcePostFailure({ customer, platform, content, err, scheduleName, createdBy }) {
  const timeLabel = formatTimestamp(new Date());
  const snsLabel = PLATFORM_DISPLAY_LABELS[platform] || platform;
  const target = scheduleName ? `スケジュール「${scheduleName}」` : "ワンショット投稿";

  const title = `${snsLabel}への投稿が失敗しました (${timeLabel})`;
  const body = [
    `TimeStamp: ${timeLabel}`,
    `SNS: ${snsLabel}`,
    `対象: ${target}`,
    `Results: 失敗`,
    `Detail: ${extractErrorDetail(err)}`,
    `Body: ${content || ""}`,
  ].join("\n");

  createAnnouncement({ customerCode: customer.id, type: "post_failure", title, body, platform, createdBy });
}

module.exports = { announcePostFailure };
