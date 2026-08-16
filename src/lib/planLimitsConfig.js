// SNS接続数のプラン別上限の単一情報源（config/planLimits.json）を読み込む。
// stripePricing.js の planKey(customer) で正規化したキー（basic/standard/advanced）で引く。
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config", "planLimits.json");

function getMaxConnections(plan) {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const limits = JSON.parse(raw);
  return limits[plan] || 0;
}

module.exports = { getMaxConnections };
