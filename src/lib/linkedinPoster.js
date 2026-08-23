// linkedin.jsのOAuth連携で使っているPosts API（ugcPostsの後継、2023年以降の推奨エンドポイント）
// バージョンに揃える。個人プロフィール投稿のみ対応（会社ページ投稿はLinkedIn側の審査待ち）。
const POSTS_URL = "https://api.linkedin.com/rest/posts";
const LINKEDIN_VERSION = "202601";

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// linkが指定された場合、article共有として本文URLのog:image/タイトルをLinkedIn側が
// 自動取得してリンクカードを表示する（Facebookのlinkパラメータと同じ役割）。
async function postText({ personUrn, accessToken }, text, link) {
  const body = {
    author: `urn:li:person:${personUrn}`,
    commentary: text,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (link) {
    body.content = { article: { source: link } };
  }

  const res = await fetch(POSTS_URL, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text2 = await res.text().catch(() => "");
    throw new Error(`linkedin post failed: ${res.status} ${text2.slice(0, 300)}`);
  }
  // 成功時、投稿IDはレスポンスボディではなくx-restli-idヘッダーで返る（LinkedIn Posts APIの仕様）。
  const id = res.headers.get("x-restli-id") || res.headers.get("X-RestLi-Id");
  return { id: id || null };
}

module.exports = { postText };
