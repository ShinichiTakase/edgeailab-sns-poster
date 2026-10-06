const { assertRepositoryContract } = require("./contracts");
const { createScheduledPostRepository } = require("./scheduledPostRepository");
const { createScheduledPostJobRepository } = require("./scheduledPostJobRepository");
const { createEffectRepository } = require("./effectRepository");
const { createMeterEventRepository } = require("./meterEventRepository");
const { createOAuthStateRepository } = require("./oauthStateRepository");
const { createSocialAccountRepository } = require("./socialAccountRepository");
const { createStripeWebhookRepository } = require("./stripeWebhookRepository");

function createRepositories(db, options = {}) {
  const common = { now: options.now, uuid: options.uuid };
  const repositories = {
    scheduledPosts: createScheduledPostRepository(db, common),
    jobs: createScheduledPostJobRepository(db, common),
    effects: createEffectRepository(db, common),
    meterEvents: createMeterEventRepository(db, common),
    stripeWebhooks: createStripeWebhookRepository(db, common),
  };
  if (options.keyring) {
    repositories.oauthStates = createOAuthStateRepository(db, { ...common, keyring: options.keyring });
    repositories.socialAccounts = createSocialAccountRepository(db, { ...common, keyring: options.keyring });
  }
  for (const name of ["scheduledPosts", "jobs", "effects", "meterEvents"]) assertRepositoryContract(name, repositories[name]);
  if (repositories.oauthStates) assertRepositoryContract("oauthStates", repositories.oauthStates);
  return repositories;
}

module.exports = { createRepositories };
