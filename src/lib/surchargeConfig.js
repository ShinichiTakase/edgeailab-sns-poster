// Xサーチャージ単価の単一情報源（config/surcharge.json）を読み込む。
// Stripe側でPriceを切り替えた際は、このJSONの数値も合わせて手動更新する運用。
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config", "surcharge.json");

function getXSurcharge() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw).x_surcharge;
}

module.exports = { getXSurcharge };
