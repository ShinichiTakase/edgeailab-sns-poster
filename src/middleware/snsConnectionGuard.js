// /oauth/{platform}/start（Xのみ /oauth/x/authorize）の先頭で使うガード。
// フロント側のボタン無効化を信用せず、サーバー側でも必ず以下2点を再検証する：
//   1. Dev Mode許可リスト（config/snsConnectionMode.json）
//   2. プランごとの接続可能SNS数の上限（config/planLimits.json）
// 判定結果はGET /api/sns-connections（src/routes/snsConnections.js）と一致させること。
const { getConnectedEntry } = require("../lib/tokenStore");
const { planKey } = require("../lib/stripePricing");
const { getMaxConnections } = require("../lib/planLimitsConfig");
const { isPlatformAvailable } = require("../lib/snsConnectionModeConfig");

function requireSnsConnectionAvailable(platform) {
  return (req, res, next) => {
    const customerId = req.customer.id;

    if (!isPlatformAvailable(platform, customerId)) {
      return res.redirect(`/onboarding.html?snsError=coming_soon&platform=${platform}`);
    }

    const entry = getConnectedEntry(customerId);
    if (!entry[platform]) {
      const maxConnections = getMaxConnections(planKey(req.customer));
      const connectedCount = Object.keys(entry).length;
      if (connectedCount >= maxConnections) {
        return res.redirect(
          `/onboarding.html?snsError=limit_reached&platform=${platform}&max=${maxConnections}`
        );
      }
    }

    next();
  };
}

module.exports = { requireSnsConnectionAvailable };
