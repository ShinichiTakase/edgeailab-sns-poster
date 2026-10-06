// Production runtime never imports this file. Individual tests must select their store explicitly.
process.env.NODE_ENV = "test";
if (process.env.SNS_POSTER_DATA_SOURCE === undefined) {
  process.env.SNS_POSTER_DATA_SOURCE = "test-legacy";
}
if (process.env.JWT_SECRET === undefined) {
  process.env.JWT_SECRET = "isolated-node-test-secret";
}
if (process.env.SNS_POSTER_LOG_DIR === undefined) {
  process.env.SNS_POSTER_LOG_DIR = "/tmp/sns-poster-node-tests/logs";
}
