// リール（Instagram / Facebook）とThreadsで、URLを投稿本文ではなくコメント（返信）に書き込む部品。
// いずれも「公開済みの投稿に付ける追加処理」であり、失敗しても投稿自体は成功のまま扱う
// （呼び出し側で捕捉してログに残す）。権限不足（Facebook: pages_manage_engagement、
// Threads: threads_manage_replies）の顧客でも、投稿が壊れないようにするため。
const { extractFirstUrl } = require("./urlDetection");

const INSTAGRAM_GRAPH_URL = "https://graph.instagram.com/v26.0";
const FACEBOOK_GRAPH_URL = "https://graph.facebook.com/v26.0";
const THREADS_GRAPH_URL = "https://graph.threads.net/v1.0";

const MAX_LINK_LENGTH = 1000;

function isValidLinkUrl(url) {
  return typeof url === "string" && url.length <= MAX_LINK_LENGTH && /^https?:\/\/\S+$/i.test(url);
}

function buildLinkCommentText(url) {
  return `詳細は、${url}をご覧ください`;
}

// ユーザー向けエラーに本文やトークンを含めない（Facebookリール送信側の方針に揃える）。
async function graphPost(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, method: "POST", signal: AbortSignal.timeout(30000), redirect: "error" });
  } catch {
    throw new Error("link_comment_transport_unconfirmed");
  }
  let json;
  try { json = await response.json(); } catch { throw new Error("link_comment_response_invalid"); }
  if (!response.ok || json.error) {
    throw Object.assign(new Error("link_comment_api_error"), { code: `graph_${json.error?.code || response.status}` });
  }
  return json;
}

async function commentOnInstagramMedia({ accessToken }, mediaId, url, fetchImpl = (...a) => fetch(...a)) {
  if (!isValidLinkUrl(url) || !mediaId) return null;
  return graphPost(fetchImpl, `${INSTAGRAM_GRAPH_URL}/${encodeURIComponent(mediaId)}/comments`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: buildLinkCommentText(url), access_token: accessToken }),
  });
}

async function commentOnFacebookVideo({ pageAccessToken }, videoId, url, fetchImpl = (...a) => fetch(...a)) {
  if (!isValidLinkUrl(url) || !videoId) return null;
  return graphPost(fetchImpl, `${FACEBOOK_GRAPH_URL}/${encodeURIComponent(videoId)}/comments`, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${pageAccessToken}` },
    body: JSON.stringify({ message: buildLinkCommentText(url) }),
  });
}

// Threadsの本文からURLを外す。外した結果が空になる場合は何もしない（本文を空にしない）。
function splitUrlFromThreadsText(text) {
  const url = extractFirstUrl(text);
  if (!url || !isValidLinkUrl(url)) return { text, url: null };
  const stripped = text
    .replace(url, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!stripped) return { text, url: null };
  return { text: stripped, url };
}

async function replyOnThreads({ userId, accessToken }, replyToId, url, fetchImpl = (...a) => fetch(...a)) {
  if (!isValidLinkUrl(url) || !replyToId) return null;
  const createParams = new URLSearchParams({
    access_token: accessToken,
    text: buildLinkCommentText(url),
    media_type: "TEXT",
    reply_to_id: String(replyToId),
  });
  const created = await graphPost(fetchImpl, `${THREADS_GRAPH_URL}/${userId}/threads?${createParams}`, {});
  if (!created.id) throw new Error("link_comment_response_invalid");
  const publishParams = new URLSearchParams({ creation_id: created.id, access_token: accessToken });
  return graphPost(fetchImpl, `${THREADS_GRAPH_URL}/${userId}/threads_publish?${publishParams}`, {});
}

// Threadsで「URLを返信へ移す」機能の有効/無効。顧客がthreads_manage_repliesを付与し直す前に
// 有効にすると、URLが本文から消えて返信も付かない投稿になるため、既定は無効。
function isThreadsUrlReplyEnabled(env = process.env) {
  return env.THREADS_URL_REPLY_ENABLED === "1";
}

module.exports = {
  isValidLinkUrl,
  buildLinkCommentText,
  commentOnInstagramMedia,
  commentOnFacebookVideo,
  splitUrlFromThreadsText,
  replyOnThreads,
  isThreadsUrlReplyEnabled,
};
