// linkedin.jsのOAuth連携で使っているPosts API（ugcPostsの後継、2023年以降の推奨エンドポイント）
// バージョンに揃える。個人プロフィール投稿のみ対応（会社ページ投稿はLinkedIn側の審査待ち）。
const { assertPublicUrl } = require("./ssrfGuard");

const POSTS_URL = "https://api.linkedin.com/rest/posts";
const LINKEDIN_VERSION = "202601";
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = "Mozilla/5.0 (compatible; EdgeAILabBot/1.0; +https://edgeailab.net)";
const OG_TITLE_PATTERN =
  /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i;
const TITLE_TAG_PATTERN = /<title[^>]*>([^<]+)<\/title>/i;

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// LinkedInのPosts APIはarticle共有時にcontent.article.titleを必須とする（ogp:imageのように
// 自動取得はしてくれない。実測で確認済み：source省略時422 "article/title field is required"）。
// og:titleが取れなければ<title>タグにフォールバックし、それも取れなければnullを返す
// （呼び出し側はarticle共有を諦めてテキストのみの投稿にフォールバックする）。
async function fetchOgTitle(pageUrl) {
  try {
    await assertPublicUrl(pageUrl);
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;

    const html = await res.text();
    const ogMatch = html.match(OG_TITLE_PATTERN);
    const raw = ogMatch ? ogMatch[1] || ogMatch[2] : (html.match(TITLE_TAG_PATTERN) || [])[1];
    if (!raw) return null;
    const title = decodeHtmlEntities(raw).trim();
    return title ? title.slice(0, 200) : null;
  } catch (e) {
    return null;
  }
}

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

async function submitPost(accessToken, body) {
  const res = await fetch(POSTS_URL, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`linkedin post failed: ${res.status} ${text.slice(0, 300)}`);
  }
  // 成功時、投稿IDはレスポンスボディではなくx-restli-idヘッダーで返る（LinkedIn Posts APIの仕様）。
  const id = res.headers.get("x-restli-id") || res.headers.get("X-RestLi-Id");
  return { id: id || null };
}

// linkが指定された場合、article共有として本文URLのタイトルを取得しLinkedIn側にリンクカードを
// 表示させる（Facebookのlinkパラメータと同じ役割）。タイトル取得に失敗した場合は
// （article.titleが必須のため）リンクカードなしのテキストのみの投稿にフォールバックする
// （og:image取得失敗時にテキストのみへフォールバックするX/xPoster.jsと同じ方針）。
async function postText({ personUrn, accessToken }, text, link) {
  const baseBody = {
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
    const title = await fetchOgTitle(link);
    if (title) {
      return submitPost(accessToken, { ...baseBody, content: { article: { source: link, title } } });
    }
  }
  return submitPost(accessToken, baseBody);
}

module.exports = { postText };
