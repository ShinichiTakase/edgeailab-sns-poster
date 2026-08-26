const express = require("express");
const crypto = require("crypto");
const { savePlatformTokens, findDuplicateOwner } = require("../lib/tokenStore");
const pkceStore = require("../lib/pkceStore");
const { requireAuth, blockExpiredTrial, blockViewerRoleRedirect, blockEditorRoleRedirect } = require("../middleware/requireAuth");
const { requireSnsConnectionAvailable } = require("../middleware/snsConnectionGuard");

const router = express.Router();

const SUCCESS_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>連携完了</title></head>
<body>
  <p id="msg">LinkedInアカウントの連携が完了しました。連携設定ページに戻ります…</p>
  <p><a id="fallback-link" href="/onboarding.html?connected=linkedin">戻らない場合はこちら</a></p>
  <script>
    (function () {
      var backUrl = "/onboarding.html?connected=linkedin";
      if (window.opener && window.opener !== window) {
        document.getElementById("msg").textContent = "LinkedInアカウントの連携が完了しました。このタブを閉じてダッシュボードにお戻りください。";
        document.getElementById("fallback-link").style.display = "none";
      } else {
        setTimeout(function () { location.href = backUrl; }, 1200);
      }
    })();
  </script>
</body></html>`;

const ERROR_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>エラー</title></head>
<body><p>エラーが発生しました。担当者にご連絡ください。</p></body></html>`;

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
// 今回のスコープは個人プロフィール投稿のみ（w_member_social）。会社ページ投稿
// （w_organization_social等）はLinkedIn側の審査待ちのため対象外。
// openid/profileはOIDC userinfoエンドポイントからperson urn（sub）を取得するために必要。
const SCOPE = "openid profile w_member_social";

router.get("/oauth/linkedin/start", requireAuth, blockExpiredTrial, blockViewerRoleRedirect, blockEditorRoleRedirect, requireSnsConnectionAvailable("linkedin"), (req, res) => {
  const slug = req.customer.id;
  const state = crypto.randomBytes(24).toString("hex");
  pkceStore.put(state, { slug });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.LINKEDIN_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.LINKEDIN_REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

router.get("/oauth/linkedin/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error(`[linkedin/callback] provider returned error: ${error}`);
    return res.status(400).send(ERROR_HTML);
  }
  if (!code || !state) {
    console.error("[linkedin/callback] missing code or state query param");
    return res.status(400).send(ERROR_HTML);
  }

  const entry = pkceStore.take(state);
  if (!entry) {
    console.error("[linkedin/callback] state mismatch or expired");
    return res.status(400).send(ERROR_HTML);
  }
  const { slug } = entry;

  try {
    const tokens = await exchangeToken(code);
    const profile = await fetchUserinfo(tokens.access_token);

    const duplicate = findDuplicateOwner("linkedin", [profile.sub], slug);
    if (duplicate) {
      console.warn(
        `[linkedin/callback] duplicate account: slug=${slug} user_id=${profile.sub} already linked to slug=${duplicate.slug}`
      );
      return res.redirect("/upgrade.html?reason=duplicate_account");
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000);

    savePlatformTokens(slug, "linkedin", {
      user_id: profile.sub,
      username: profile.name || profile.sub,
      access_token: tokens.access_token,
      token_expires_at: expiresAt.toISOString(),
      updated_at: now.toISOString(),
    });

    console.info(`[linkedin/callback] linked slug=${slug} username=${profile.name || profile.sub} expires_at=${expiresAt.toISOString()}`);
    return res.send(SUCCESS_HTML);
  } catch (err) {
    console.error("[linkedin/callback] failed:", err);
    return res.status(500).send(ERROR_HTML);
  }
});

// LinkedInはXと異なりBasic認証を要求せず、client_secretをボディに含める方式のみ対応。
async function exchangeToken(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
    client_id: process.env.LINKEDIN_CLIENT_ID,
    client_secret: process.env.LINKEDIN_CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

// OIDC userinfoエンドポイント。subがurn:li:person:{sub}組み立てに使うLinkedInの内部ユーザーID。
async function fetchUserinfo(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json();
  if (!res.ok || !json.sub) {
    throw new Error(`userinfo fetch failed: ${JSON.stringify(json)}`);
  }
  return json;
}

module.exports = router;
