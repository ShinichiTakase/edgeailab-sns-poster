// facebook.jsのOAuth連携で使っているGraph APIバージョンに揃える。
const GRAPH_API_VERSION = "v26.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

async function postText({ pageId, pageAccessToken }, text, imageUrl) {
  const url = imageUrl ? `${GRAPH_URL}/${pageId}/photos` : `${GRAPH_URL}/${pageId}/feed`;
  const body = imageUrl
    ? { url: imageUrl, caption: text, access_token: pageAccessToken }
    : { message: text, access_token: pageAccessToken };

  const res = await fetch(url, {
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
