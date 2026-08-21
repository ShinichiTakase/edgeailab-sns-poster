// microCMS の schedule_texts スキーマ（スケジュール投稿に紐づく投稿文章）へのアクセス。
// ラウンドロビンの消化順はcreatedAt昇順（追加のorder管理フィールドは持たせない）。
const { microcmsFetch } = require("./microcms");

async function listScheduleTexts(scheduleId) {
  const all = [];
  const limit = 100;
  let offset = 0;
  const filters = `schedule_id[equals]${encodeURIComponent(scheduleId)}`;
  for (;;) {
    // microCMSはデフォルトpublishedAt降順のため、ラウンドロビン順を保証するよう明示的に昇順指定する。
    const res = await microcmsFetch(`/schedule_texts?filters=${filters}&orders=createdAt&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduleTextStore] listScheduleTexts failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

// scheduleMaterializer.jsのラウンドロビン抽選プール用。承認待ち・却下・失効中のバッチだけを
// 除外する（included側をnone/approvedのORで絞ると、承認機能導入前からある既存の投稿文章
// （approval_status未設定＝空配列）が[contains]に一致せず全滅する。実機検証済み、2026-08-21）。
async function listApprovedScheduleTexts(scheduleId) {
  const all = [];
  const limit = 100;
  let offset = 0;
  const filters = [
    `schedule_id[equals]${encodeURIComponent(scheduleId)}`,
    "approval_status[not_contains]pending",
    "approval_status[not_contains]rejected",
    "approval_status[not_contains]expired",
  ].join("[and]");
  for (;;) {
    const res = await microcmsFetch(`/schedule_texts?filters=${filters}&orders=createdAt&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduleTextStore] listApprovedScheduleTexts failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

async function getScheduleTextById(id) {
  const res = await microcmsFetch(`/schedule_texts/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduleTextStore] getScheduleTextById failed ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function createScheduleText({
  scheduleId,
  xText,
  threadsText,
  facebookText,
  instagramText,
  instagramImageUrl,
  instagramVideoUrl,
  sourceExcerpt,
  createdBy,
  approvalFields,
}) {
  const res = await microcmsFetch(`/schedule_texts`, {
    method: "POST",
    body: JSON.stringify({
      schedule_id: scheduleId,
      x_text: xText || "",
      threads_text: threadsText || "",
      facebook_text: facebookText || "",
      instagram_text: instagramText || "",
      instagram_image_url: instagramImageUrl || "",
      instagram_video_url: instagramVideoUrl || "",
      source_excerpt: sourceExcerpt || "",
      created_by: createdBy || "",
      // 承認ステータス関連フィールド（approvalStore.jsのbuildApprovalFields/noneApprovalFields）。
      // 未指定時（既存呼び出し元との後方互換）はnoneApprovalFields相当を明示的に渡すこと。
      ...(approvalFields || {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduleTextStore] createScheduleText failed ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function updateScheduleText(id, patch) {
  const res = await microcmsFetch(`/schedule_texts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduleTextStore] updateScheduleText failed ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function deleteScheduleText(id) {
  const res = await microcmsFetch(`/schedule_texts/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduleTextStore] deleteScheduleText failed ${res.status} ${text.slice(0, 300)}`);
  }
}

module.exports = {
  listScheduleTexts,
  listApprovedScheduleTexts,
  getScheduleTextById,
  createScheduleText,
  updateScheduleText,
  deleteScheduleText,
};
