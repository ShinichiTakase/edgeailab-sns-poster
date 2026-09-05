// 管理者ダッシュボード「パスワード初期化」用のランダムパスワード生成。
// 誤読しやすい文字（0/O、1/l/I等）を除いた文字集合から、crypto.randomIntで
// 暗号学的に安全な乱数選択を行う。
const crypto = require("crypto");

const CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function generatePassword(length = 12) {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += CHARSET[crypto.randomInt(CHARSET.length)];
  }
  return result;
}

module.exports = { generatePassword };
