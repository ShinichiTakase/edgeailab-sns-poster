// ユーザー（管理者含む）数のプラン別上限の単一情報源（config/teamMemberLimits.json）を読み込む。
// pricing.html記載の「ユーザー（管理者）数上限」（Basic 1名／Standard・Advanced 各3名）と一致させること。
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config", "teamMemberLimits.json");

function getMaxTeamMembers(plan) {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const limits = JSON.parse(raw);
  return limits[plan] || 0;
}

module.exports = { getMaxTeamMembers };
