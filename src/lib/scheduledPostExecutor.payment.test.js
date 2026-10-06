process.env.SNS_POSTER_DATA_SOURCE = "test-legacy";
// 本番データ・APIを使わず、課金切替後の連続予約と各SNSへの送信境界を検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const customers = require('./customerStore');
const activation = require('./trialLimitAutoActivation');
const scheduled = require('./scheduledPostStore');
const logs = require('./postingLogStore');
const origins = require('./postingLogOriginStore');
const tokens = require('./tokenStore');
const meters = require('./meterEvents');
const schedules = require('./scheduleStore');
const mail = require('./scheduleResultMailer');

let persisted, sent, statuses, billed, activated;
customers.getCustomerById = async () => structuredClone(persisted);
customers.bumpTrialPostCount = async (_id, customer, delta) => {
  persisted.trialPostCount = customer.trialPostCount + delta;
  return persisted.trialPostCount;
};
activation.activateAfterTrialLimitIfNeeded = async () => {
  activated++;
  persisted.status = ['active'];
  persisted.stripeSubscriptionId = 'sub_isolated';
  return 'activated';
};
activation.sendTrialPostLimitReachedEmailIfNeeded = async () => false;
scheduled.markScheduledPostStatus = async (_id, status) => statuses.push(status);
logs.createPostingLog = async () => ({ id: 'isolated_log' });
origins.recordScheduledOrigin = () => {};
meters.reportMeterEvent = async name => billed.push(name);
schedules.getScheduleById = async () => ({ notify_email: false });
mail.sendScheduleResultEmail = async () => false;
tokens.loadStore = () => ({ isolated_customer: {
  x: {}, threads: {}, linkedin: {}, instagram: {},
  facebook: { pages: [{ pageId: 'isolated_page' }] },
} });
for (const [moduleName, method, platform] of [
  ['xPoster', 'postTextWithLinkImage', 'x'],
  ['threadsPoster', 'postText', 'threads'],
  ['facebookPoster', 'postText', 'facebook'],
  ['linkedinPoster', 'postText', 'linkedin'],
  ['instagramPoster', 'postImage', 'instagram'],
  ['instagramPoster', 'postReel', 'instagram'],
]) require('./' + moduleName)[method] = async () => {
  sent.push(platform);
  return { id: 'isolated_post' };
};
const { attemptScheduledPost } = require('./scheduledPostExecutor');
const logger = { logError() {} };
const post = (id, platform = 'x') => ({
  id, platform: [scheduled.PLATFORM_LABELS[platform]], customer_code: 'isolated_customer',
  content: 'isolated test', source_schedule_id: 'isolated_schedule', notify_email: false,
});
test.beforeEach(() => {
  persisted = { id: 'isolated_customer', status: ['trial'], trialPostCount: 59,
    stripeCustomerId: 'cus_isolated', trialEndsAt: '2099-01-01T00:00:00Z' };
  sent = []; statuses = []; billed = []; activated = 0;
});
test('60通目の成功後に本契約化した顧客の次の予約も実行できる', async () => {
  const cache = new Map();
  await attemptScheduledPost(post('first'), cache, logger);
  await attemptScheduledPost(post('second'), cache, logger);
  assert.deepEqual(sent, ['x', 'x']);
  assert.equal(activated, 1);
  assert.equal(cache.get('isolated_customer').stripeSubscriptionId, 'sub_isolated');
});
test('既に上限到達した顧客を本契約化した場合も次の予約を止めない', async () => {
  persisted.trialPostCount = 60;
  const cache = new Map();
  await attemptScheduledPost(post('first'), cache, logger);
  await attemptScheduledPost(post('second'), cache, logger);
  assert.deepEqual(sent, ['x', 'x']);
  assert.equal(activated, 1);
});
test('期限切れ未払いの予約は全5SNSで送信・done保存・meter送信より前に拒否', async () => {
  persisted.trialPostCount = 10;
  persisted.trialEndsAt = '2000-01-01T00:00:00Z';
  for (const platform of ['x', 'threads', 'facebook', 'linkedin', 'instagram']) {
    await assert.rejects(attemptScheduledPost(post(platform, platform), new Map(), logger), /payment_required/);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(statuses, []);
  assert.deepEqual(billed, []);
  assert.equal(activated, 0);
});
test('本契約済みの予約は全5SNSで送信成功後にdone保存とmeter送信を行う', async () => {
  persisted.status = ['active']; persisted.stripeSubscriptionId = 'sub_isolated';
  for (const platform of ['x', 'threads', 'facebook', 'linkedin', 'instagram']) {
    await attemptScheduledPost(post(platform, platform), new Map(), logger);
  }
  assert.deepEqual(sent, ['x', 'threads', 'facebook', 'linkedin', 'instagram']);
  assert.deepEqual(statuses, Array(5).fill('done'));
  assert.deepEqual(billed, Array(5).fill('post_created'));
});
