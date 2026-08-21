// facebook.jsのOAuth連携で使っているGraph APIバージョンに揃える。
const GRAPH_API_VERSION = "v26.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// linkを指定すると、本文にURLが含まれていてもGraph API側の自動リンクカード生成に頼らず
// 確実にog:imageリンクプレビューを付与できる（/feedへmessageのみを渡す方式は、本文中に
// URLがあってもプレビューが表示されないことがあるため。実機で確認済み、2026-08-21）。
async function postText({ pageId, pageAccessToken }, text, link) {
  const body = { message: text, access_token: pageAccessToken };
  if (link) body.link = link;
  const res = await fetch(`${GRAPH_URL}/${pageId}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`facebook post failed: ${JSON.stringify(json)}`);
  }
  return { id: json.post_id || json.id };
}

module.exports = { postText };
