const express = require("express");
const crypto = require("crypto");
const { savePlatformTokens } = require("../lib/tokenStore");
const pkceStore = require("../lib/pkceStore");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

const SUCCESS_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>連携完了</title></head>
<body><p>Xアカウントの連携が完了しました。このページを閉じてください。</p></body></html>`;

const ERROR_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>エラー</title></head>
<body><p>エラーが発生しました。担当者にご連絡ください。</p></body></html>`;

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const USERS_ME_URL = "https://api.x.com/2/users/me";
const SCOPE = "tweet.read tweet.write users.read offline.access";

router.get("/oauth/x/authorize", requireAuth, (req, res) => {
  const slug = req.customer.id;

  const codeVerifier = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(24).toString("hex");

  pkceStore.put(state, { slug, codeVerifier });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.X_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.X_REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  res.redirect(url.toString());
});

router.get("/oauth/x/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error(`[x/callback] provider returned error: ${error}`);
    return res.status(400).send(ERROR_HTML);
  }
  if (!code || !state) {
    console.error("[x/callback] missing code or state query param");
    return res.status(400).send(ERROR_HTML);
  }

  const entry = pkceStore.take(state);
  if (!entry) {
    console.error("[x/callback] state mismatch or expired");
    return res.status(400).send(ERROR_HTML);
  }
  const { slug, codeVerifier } = entry;

  try {
    const tokens = await exchangeToken(code, codeVerifier);
    const profile = await fetchUser(tokens.access_token);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000);

    savePlatformTokens(slug, "x", {
      user_id: profile.id,
      username: profile.username,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: expiresAt.toISOString(),
      updated_at: now.toISOString(),
    });

    console.info(`[x/callback] linked slug=${slug} username=${profile.username} expires_at=${expiresAt.toISOString()}`);
    return res.send(SUCCESS_HTML);
  } catch (err) {
    console.error("[x/callback] failed:", err);
    return res.status(500).send(ERROR_HTML);
  }
});

function basicAuthHeader() {
  const raw = `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

// Xはconfidential clientに対してBasic認証を要求するケースがあるため、まずBasic認証
// ヘッダー付きで試し、providerがerrorを返したらボディにclient_secretを含める方式に
// フォールバックする。
async function exchangeToken(code, codeVerifier) {
  const commonParams = {
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.X_REDIRECT_URI,
    code_verifier: codeVerifier,
  };

  let res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams(commonParams),
  });
  let json = await res.json();

  if (!res.ok || json.error) {
    console.warn(`[x/callback] Basic auth token exchange failed (${json.error || res.status}), retrying with client_secret in body`);
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...commonParams,
        client_id: process.env.X_CLIENT_ID,
        client_secret: process.env.X_CLIENT_SECRET,
      }),
    });
    json = await res.json();
  }

  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function fetchUser(accessToken) {
  const res = await fetch(USERS_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok || json.errors || !json.data || !json.data.id) {
    throw new Error(`user fetch failed: ${JSON.stringify(json)}`);
  }
  return json.data;
}

module.exports = router;
