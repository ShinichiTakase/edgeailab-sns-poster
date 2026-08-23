// linkedin.jsのOAuth連携で使っているPosts API（ugcPostsの後継、2023年以降の推奨エンドポイント）
// バージョンに揃える。個人プロフィール投稿のみ対応（会社ページ投稿はLinkedIn側の審査待ち）。
const { assertPublicUrl } = require("./ssrfGuard");

const POSTS_URL = "https://api.linkedin.com/rest/posts";
const IMAGE_UPLOAD_INIT_URL = "https://api.linkedin.com/rest/images?action=initializeUpload";
const LINKEDIN_VERSION = "202601";
const FETCH_TIMEOUT_MS = 10000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // xPoster.js/ogImageFetcher.jsと同じ上限に揃える
const USER_AGENT = "Mozilla/5.0 (compatible; EdgeAILabBot/1.0; +https://edgeailab.net)";
const OG_TITLE_PATTERN =
  /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i;
const TITLE_TAG_PATTERN = /<title[^>]*>([^<]+)<\/title>/i;
const OG_IMAGE_PATTERN =
  /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i;

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
// og:titleが取れなければ<title>タグにフォールバックする。ページ取得は1回で済ませ、
// タイトルとog:image（サムネイル候補）の両方をここで抽出する
// （ogImageFetcher.jsのfetchOgImageを流用すると同じページをもう一度fetchすることになるため、
// LinkedIn向けに専用実装している）。
async function fetchOgMeta(pageUrl) {
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

    const ogTitleMatch = html.match(OG_TITLE_PATTERN);
    const rawTitle = ogTitleMatch ? ogTitleMatch[1] || ogTitleMatch[2] : (html.match(TITLE_TAG_PATTERN) || [])[1];
    const title = rawTitle ? decodeHtmlEntities(rawTitle).trim().slice(0, 200) || null : null;

    const ogImageMatch = html.match(OG_IMAGE_PATTERN);
    const rawImageUrl = ogImageMatch ? ogImageMatch[1] || ogImageMatch[2] : null;
    const imageUrl = rawImageUrl ? new URL(rawImageUrl, pageUrl).toString() : null;

    return { title, imageUrl };
  } catch (e) {
    return null;
  }
}

// og:imageの画像バイナリをダウンロードする（ogImageFetcher.jsのfetchOgImageと同じ検証基準）。
async function downloadImage(imageUrl) {
  try {
    await assertPublicUrl(imageUrl);
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\/(jpeg|png|gif|webp)$/i.test(contentType)) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
    return { buffer, mimeType: contentType };
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

// LinkedInのarticle.thumbnailは画像URLを直接渡せず、事前にアップロードして得た
// 画像アセットのURNを渡す必要がある（X/xPoster.jsのuploadImageと同じINIT→バイナリPUTの
// 2段階方式。ただしAPPEND/FINALIZEはなく、PUT一発で完了する）。
async function uploadImage(accessToken, personUrn, buffer) {
  const initRes = await fetch(IMAGE_UPLOAD_INIT_URL, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({ initializeUploadRequest: { owner: `urn:li:person:${personUrn}` } }),
  });
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => "");
    throw new Error(`linkedin image init failed: ${initRes.status} ${text.slice(0, 300)}`);
  }
  const initJson = await initRes.json();
  const uploadUrl = initJson.value && initJson.value.uploadUrl;
  const imageUrn = initJson.value && initJson.value.image;
  if (!uploadUrl || !imageUrn) {
    throw new Error(`linkedin image init missing fields: ${JSON.stringify(initJson)}`);
  }

  // アップロード先URL（LinkedInが発行する一時URL）へはLinkedIn-Version等のAPIヘッダーは不要。
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: buffer,
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`linkedin image upload failed: ${putRes.status} ${text.slice(0, 300)}`);
  }
  return imageUrn;
}

// linkが指定された場合、article共有として本文URLのタイトル・og:imageを取得しLinkedIn側に
// リンクカードを表示させる（Facebookのlinkパラメータと同じ役割）。タイトル取得に失敗した場合は
// （article.titleが必須のため）リンクカードなしのテキストのみの投稿にフォールバックする。
// 画像の取得・アップロードだけが失敗した場合は、サムネイルなしのarticle共有（title/sourceのみ）に
// 留めて投稿自体は続行する（og:image取得失敗時にテキストのみへフォールバックするX/xPoster.jsと
// 同じ「見た目の補助機能の失敗で投稿自体を止めない」方針）。
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
    const meta = await fetchOgMeta(link);
    if (meta && meta.title) {
      const article = { source: link, title: meta.title };
      if (meta.imageUrl) {
        try {
          const image = await downloadImage(meta.imageUrl);
          if (image) {
            article.thumbnail = await uploadImage(accessToken, personUrn, image.buffer);
          }
        } catch (err) {
          console.error("[linkedinPoster] thumbnail upload failed, posting without it:", err);
        }
      }
      return submitPost(accessToken, { ...baseBody, content: { article } });
    }
  }
  return submitPost(accessToken, baseBody);
}

module.exports = { postText };
