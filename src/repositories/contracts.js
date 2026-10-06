const REQUIRED_METHODS = Object.freeze({
  scheduledPosts: ["createWithJob", "getById"],
  jobs: ["claimNext", "markRequestStarted", "markSent", "markFailed", "markAmbiguous", "recoverExpiredLeases", "markDone", "cancel"],
  effects: ["ensure", "claim"],
  meterEvents: ["ensure", "claim"],
  oauthStates: ["create", "consume"],
});

function assertRepositoryContract(name, repository) {
  const methods = REQUIRED_METHODS[name];
  if (!methods) throw new Error(`unknown repository contract: ${name}`);
  for (const method of methods) {
    if (typeof repository[method] !== "function") throw new Error(`${name} repository is missing ${method}()`);
  }
  return repository;
}

module.exports = { REQUIRED_METHODS, assertRepositoryContract };
