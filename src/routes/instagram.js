const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { savePlatformTokens, getConnectedEntry, deletePlatformTokensByUserId, findDuplicateOwner } = require("../lib/tokenStore");
// state(OAuth) と同じ「短命トークン→データ」の仕組みを、アカウント切替確認の
// 一時保管にもそのまま流用する（用途はPKCE専用ではなく汎用のTTL付きmapのため）。
const pkceStore = require("../lib/pkceStore");
const { requireAuth, blockExpiredTrial } = require("../middleware/requireAuth");
const { requireSnsConnectionAvailable } = require("../middleware/snsConnectionGuard");

const router = express.Router();

// facebook.js と同様、json/ 配下（volumeマウントでコンテナ再ビルド後も残る）に
// 標準出力とは別で永続化する。docker logsのローテーションで消える前の記録用。
const LOG_FILE = path.join(__dirname, "..", "..", "json", "instagram.log");

function writeLogFile(level, args) {
  const message = args
    .map((a) => (a instanceof Error ? a.stack : typeof a === "object" ? JSON.stringify(a) : a))
    .join(" ");
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error("[instagram] failed to write log file:", err);
  }
}

function logInfo(...args) {
  console.info(...args);
  writeLogFile("info", args);
}

function logWarn(...args) {
  console.warn(...args);
  writeLogFile("warn", args);
}

function logError(...args) {
  console.error(...args);
  writeLogFile("error", args);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 連携が完了したアカウント名をこの画面上で明示する。削除→再連携のように「上書き」判定に
// 引っかからない一見普通の新規連携でも、Meta側のアカウント選択で意図しないアカウントを
// 選んでしまうケースはあり得るため、ここで一度目に見える形にして気づけるようにする。
function successHtml(username) {
  const safeUsername = escapeHtml(username || "");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>連携完了</title>
<style>
  body { display: flex; justify-content: center; margin: 0; padding-top: 15vh; font-family: sans-serif; }
  .box { border: 2px solid #333; border-radius: 8px; padding: 2rem 3rem; text-align: center; }
</style>
</head>
<body><div class="box">
  <p id="msg">Instagramアカウント「<strong>${safeUsername}</strong>」の連携が完了しました。連携設定ページに戻ります…</p>
  <p><a id="fallback-link" href="/onboarding.html?connected=instagram">戻らない場合はこちら</a></p>
</div>
<script>
  (function () {
    var backUrl = "/onboarding.html?connected=instagram";
    if (window.opener && window.opener !== window) {
      document.getElementById("msg").innerHTML = 'Instagramアカウント「<strong>${safeUsername}</strong>」の連携が完了しました。このタブを閉じてダッシュボードにお戻りください。';
      document.getElementById("fallback-link").style.display = "none";
    } else {
      setTimeout(function () { location.href = backUrl; }, 1800);
    }
  })();
</script>
</body></html>`;
}

const ERROR_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>エラー</title></head>
<body><p>エラーが発生しました。担当者にご連絡ください。</p></body></html>`;

// facebook.js の GRAPH_API_VERSION と揃える。
const GRAPH_API_VERSION = "v26.0";
const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const SHORT_LIVED_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const LONG_LIVED_TOKEN_URL = "https://graph.instagram.com/access_token";
const GRAPH_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

// 動作確認・実運用の両方でこのエンドポイントから開始する。
// state を発行してslug（クライアント識別子）と紐付け、Facebook/Threadsの実装と同じ方式でコールバックへ受け渡す。
router.get("/oauth/instagram/start", requireAuth, blockExpiredTrial, requireSnsConnectionAvailable("instagram"), (req, res) => {
  const slug = req.customer.id;

  const state = crypto.randomBytes(24).toString("hex");
  pkceStore.put(state, { slug });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("force_reauth", "true");
  url.searchParams.set("client_id", process.env.INSTAGRAM_APP_ID);
  url.searchParams.set("redirect_uri", process.env.INSTAGRAM_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  // content_publish はユースケースの「必須権限」バンドルに自動で含まれないため、
  // 明示的に指定しないと投稿権限が付与されない点に注意。
  url.searchParams.set(
    "scope",
    [
      "instagram_business_basic",
      "instagram_business_content_publish",
      "instagram_business_manage_comments",
      "instagram_business_manage_messages",
      "instagram_business_manage_insights",
    ].join(",")
  );

  res.redirect(url.toString());
});

router.get("/oauth/instagram/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) {
    logError(`[instagram/callback] provider returned error: ${error} ${errorDescription || ""}`);
    return res.status(400).send(ERROR_HTML);
  }
  if (!code || !state) {
    logError("[instagram/callback] missing code or state query param");
    return res.status(400).send(ERROR_HTML);
  }

  const entry = pkceStore.take(state);
  if (!entry) {
    logError("[instagram/callback] state mismatch or expired");
    return res.status(400).send(ERROR_HTML);
  }
  const { slug } = entry;

  try {
    const shortLived = await exchangeShortLivedToken(code);
    const longLived = await exchangeLongLivedToken(shortLived.access_token);
    // Facebook/ThreadsのPage検証と同等の位置づけとして、プロフィール取得の成功を
    // 読み取り専用API疎通確認とみなす。
    const profile = await fetchProfile(longLived.access_token);

    const duplicate = findDuplicateOwner("instagram", [profile.id], slug);
    if (duplicate) {
      logWarn(
        `[instagram/callback] duplicate account: slug=${slug} user_id=${profile.id} already linked to slug=${duplicate.slug}`
      );
      return res.redirect("/upgrade.html?reason=duplicate_account");
    }

    const now = new Date();
    const tokenData = {
      user_id: profile.id,
      username: profile.username,
      access_token: longLived.access_token,
      token_expires_at: new Date(now.getTime() + longLived.expires_in * 1000).toISOString(),
      permissions: shortLived.permissions,
      updated_at: now.toISOString(),
    };

    // 既にこのslugに別アカウントが連携済みの場合、無言で上書きしない。
    // 2026-08-21に、連携先が別アカウント（edgeai_lab）へ差し替わった状態のまま予約投稿が
    // 実行され、意図した顧客アカウント（shin_tks818）に投稿が反映されない事故が発生したため、
    // 本人が明示的に「切り替える」を選ぶまで保存を保留する。
    const existing = getConnectedEntry(slug).instagram;
    if (existing && existing.user_id !== profile.id) {
      const switchToken = crypto.randomBytes(24).toString("hex");
      pkceStore.put(switchToken, { slug, tokenData });
      logWarn(
        `[instagram/callback] switch pending: slug=${slug} from=${existing.username || existing.user_id} to=${profile.username}`
      );
      const qs = new URLSearchParams({
        instagramSwitch: switchToken,
        from: existing.username || existing.user_id,
        to: profile.username,
      });
      return res.redirect(`/onboarding.html?${qs.toString()}`);
    }

    savePlatformTokens(slug, "instagram", tokenData);

    logInfo(`[instagram/callback] linked slug=${slug} username=${profile.username}`);
    return res.send(successHtml(profile.username));
  } catch (err) {
    logError("[instagram/callback] failed:", err);
    return res.status(500).send(ERROR_HTML);
  }
});

// 上のswitch-pending分岐で保留したアカウント切替を、本人の明示操作で確定させる。
// tokenは一度きり使用（pkceStore.take）で、かつ発行時のslugと現在ログイン中の顧客が
// 一致する場合のみ確定できる（第三者がURLを推測してもトークンを盗み見ない限り確定できない）。
router.post("/api/instagram/confirm-switch", requireAuth, express.json(), (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token_required" });

  const pending = pkceStore.take(token);
  if (!pending || pending.slug !== req.customer.id) {
    return res.status(400).json({ error: "invalid_or_expired_token" });
  }

  savePlatformTokens(pending.slug, "instagram", pending.tokenData);
  logInfo(
    `[instagram/callback] linked slug=${pending.slug} username=${pending.tokenData.username} (switch confirmed by user)`
  );
  res.json({ ok: true, username: pending.tokenData.username });
});

router.post(
  "/api/instagram/data-deletion-callback",
  express.urlencoded({ extended: false }),
  (req, res) => {
    try {
      const { signed_request: signedRequest } = req.body;
      if (!signedRequest) {
        return res.status(400).json({ error: "signed_request is missing" });
      }

      const payload = parseSignedRequest(signedRequest, process.env.INSTAGRAM_APP_SECRET);
      const userId = payload.user_id;

      const affectedSlugs = deletePlatformTokensByUserId("instagram", userId);
      logInfo(
        `[instagram/data-deletion] user_id=${userId} removed from slugs=[${affectedSlugs.join(", ")}]`
      );

      const confirmationCode = crypto.randomBytes(8).toString("hex");
      res.json({
        url: `https://edgeailab.net/instagram/data-deletion?id=${confirmationCode}`,
        confirmation_code: confirmationCode,
      });
    } catch (err) {
      logError("[instagram/data-deletion] failed:", err);
      res.status(400).json({ error: "signed_request verification failed" });
    }
  }
);

// Instagram Business LoginのDeauthorization callbackがsigned_requestを送ってくるか
// JSON bodyかは未確認（2026-08-11時点）。まずは受信内容をそのままログに残す最小実装とし、
// 実際の呼び出しを確認した上で必要ならparseSignedRequestを適用する。
router.post("/oauth/instagram/deauthorize", express.urlencoded({ extended: false }), (req, res) => {
  logInfo("[instagram/deauthorize] received:", req.body);
  res.sendStatus(200);
});

function parseSignedRequest(signedRequest, appSecret) {
  const [encodedSig, encodedPayload] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload) {
    throw new Error("malformed signed_request");
  }

  const sig = Buffer.from(encodedSig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const expectedSig = crypto.createHmac("sha256", appSecret).update(encodedPayload).digest();

  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error("signed_request signature mismatch");
  }

  const decoded = Buffer.from(encodedPayload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf-8"
  );
  return JSON.parse(decoded);
}

// code→短命トークンの交換はmultipart/form-data指定だが、URLSearchParamsをbodyに渡すと
// fetchがContent-Type: application/x-www-form-urlencodedを自動付与し、これでも受理される
// （threads.jsの実装と同じ方式）。multipart必須のエラーが出た場合はFormDataに切り替えること。
async function exchangeShortLivedToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    client_secret: process.env.INSTAGRAM_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: process.env.INSTAGRAM_REDIRECT_URI,
    code,
  });

  const res = await fetch(SHORT_LIVED_TOKEN_URL, {
    method: "POST",
    body: params,
  });
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`short-lived token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function exchangeLongLivedToken(shortLivedToken) {
  const url = new URL(LONG_LIVED_TOKEN_URL);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", process.env.INSTAGRAM_APP_SECRET);
  url.searchParams.set("access_token", shortLivedToken);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`long-lived token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function fetchProfile(accessToken) {
  const url = new URL(`${GRAPH_URL}/me`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.username) {
    throw new Error(`profile fetch failed: ${JSON.stringify(json)}`);
  }
  return json;
}

module.exports = router;
