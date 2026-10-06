const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadConnectionMode,
  isPlatformAvailable,
} = require("./snsConnectionModeConfig");

test("正式提供対象の5 SNSはliveモードで一般顧客が利用できる", () => {
  const config = loadConnectionMode();
  const platforms = ["x", "threads", "facebook", "linkedin", "instagram"];

  for (const platform of platforms) {
    assert.equal(config[platform]?.mode, "live", `${platform} must be live`);
    assert.equal(isPlatformAvailable(platform, "non-allowlisted-customer"), true);
  }
});
