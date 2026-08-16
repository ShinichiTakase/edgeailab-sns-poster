const TWEETS_URL = "https://api.x.com/2/tweets";

async function postText(accessToken, text) {
  const res = await fetch(TWEETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`tweet post failed: ${JSON.stringify(json)}`);
  }
  return { id: json.data.id };
}

module.exports = { postText };
