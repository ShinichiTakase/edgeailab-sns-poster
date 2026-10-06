const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { isPrivateAddress, assertPublicUrl } = require('./ssrfGuard');
const { fetchPublicResource } = require('./publicUrlFetcher');
const { fetchUrlText } = require('./urlTextFetcher');
const { fetchOgImage } = require('./ogImageFetcher');
const { classifyFetchError, classifyGenerationError } = require('./generationErrors');

function network(t, pages, lookup = async () => [{ address: '93.184.216.34', family: 4 }]) {
  t.mock.method(dns, 'lookup', lookup);
  const calls = [];
  const get = (url, options, callback) => {
    const request = new EventEmitter();
    calls.push({ url: url.href, options });
    process.nextTick(() => {
      if (options.signal.aborted) return request.emit('error', new Error('aborted'));
      const page = pages[url.href];
      if (!page) return request.emit('error', new Error('unexpected URL'));
      const response = Readable.from((page.chunks || [page.body || '']).map(x => Buffer.from(x)));
      response.statusCode = page.status || 200;
      response.headers = { 'content-type': 'text/html; charset=utf-8', ...page.headers };
      callback(response);
    });
    return request;
  };
  t.mock.method(http, 'get', get);
  t.mock.method(https, 'get', get);
  return calls;
}

test('非公開IPv4/IPv6とmapped IPv4を拒否する', () => {
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','0.0.0.0','100.64.0.1','224.0.0.1','::','::1','::ffff:127.0.0.1','::ffff:7f00:1','fe90::1','fd00::1','ff02::1','2002:7f00:1::']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['93.184.216.34','8.8.8.8','2606:4700:4700::1111']) assert.equal(isPrivateAddress(address), false, address);
});

test('数値/16進IP・URL資格情報・非HTTP schemeを拒否する', async () => {
  for (const url of ['http://2130706433/','http://0x7f000001/','http://[::ffff:127.0.0.1]/','http://[::]/','http://user:password@example.com/','file:///etc/passwd']) {
    await assert.rejects(assertPublicUrl(url));
  }
});

test('複数DNS応答にprivate IPが1件でも含まれれば接続しない', async t => {
  const calls=network(t, {}, async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]);
  await assert.rejects(fetchPublicResource('https://example.com/'), /url_not_allowed/);
  assert.equal(calls.length,0);
});

test('public URLからmetadata/private IPへのredirectを接続前に拒否する', async t => {
  const calls=network(t, {'https://example.com/':{status:302,headers:{location:'http://169.254.169.254/latest/meta-data/'}}});
  await assert.rejects(fetchPublicResource('https://example.com/'), /url_not_allowed/);
  assert.equal(calls.length,1);
});

test('DNS rebindingを防ぐため検証したIPをtransport lookupにも固定する', async t => {
  let resolutions=0;
  const calls=network(t, {'https://example.com/':{body:'ok'}},async()=>[{address:++resolutions===1?'93.184.216.34':'127.0.0.1',family:4}]);
  assert.equal((await fetchPublicResource('https://example.com/')).body.toString(),'ok');
  calls[0].options.lookup('example.com',{all:true},(err,addresses)=>{
    assert.equal(err,null); assert.equal(addresses[0].address,'93.184.216.34');
  });
  assert.equal(resolutions,1);
  assert.equal(calls[0].options.agent,false);
});

test('相対redirectと最終URL、redirect上限', async t => {
  network(t, {'https://example.com/':{status:301,headers:{location:'/final'}},'https://example.com/final':{body:'ok'}});
  assert.equal((await fetchPublicResource('https://example.com/')).url,'https://example.com/final');
  await assert.rejects(fetchPublicResource('https://example.com/',{maxRedirects:0}),/redirect_limit/);
});

test('Content-Lengthなしの巨大応答も受信中に打ち切る', async t => {
  network(t, {'https://example.com/':{chunks:['123','456']}});
  await assert.rejects(fetchPublicResource('https://example.com/',{maxBytes:5}),/response_too_large/);
});

test('DNS待機にも全体timeoutを適用し、timeout後に接続しない', async t => {
  const calls=network(t,{},()=>new Promise(resolve=>setTimeout(()=>resolve([{address:'93.184.216.34',family:4}]),30)));
  await assert.rejects(fetchPublicResource('https://example.com/',{timeoutMs:5}),/fetch_timeout/);
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(calls.length,0);
});

test('日本語・英語・titleなし本文を抽出し、長文を8000文字に制限する', async t => {
  network(t, {'https://example.com/':{body:'<html><script>hidden</script><p>日本語 &amp; English</p></html>'},'https://example.com/long':{body:'<p>'+ '文'.repeat(9000)+'</p>'}});
  assert.equal(await fetchUrlText('https://example.com/'),'日本語 & English');
  assert.equal((await fetchUrlText('https://example.com/long')).length,8000);
});

test('空本文・取得拒否・非HTMLの異常系を区別する', async t => {
  network(t, {'https://example.com/':{body:'<script>only script</script>'},'https://example.com/denied':{status:403},'https://example.com/json':{headers:{'content-type':'application/json'},body:'{}'}});
  await assert.rejects(fetchUrlText('https://example.com/'),/empty_content/);
  await assert.rejects(fetchUrlText('https://example.com/denied'),/fetch_failed_403/);
  await assert.rejects(fetchUrlText('https://example.com/json'),/unsupported_content_type/);
});

test('OG画像のprivate redirectも拒否しテキスト投稿へフォールバックする',async t=>{
  const calls=network(t,{'https://example.com/':{body:'<meta property="og:image" content="/image">'},'https://example.com/image':{status:302,headers:{location:'http://127.0.0.1/'}}});
  assert.equal(await fetchOgImage('https://example.com/'),null);
  assert.equal(calls.length,2);
});

test('AI API異常・取得timeoutの表示用分類',()=>{
  assert.equal(classifyFetchError(new Error('fetch_timeout')).code,'url_fetch_timeout');
  assert.equal(classifyFetchError(new Error('fetch_failed_403')).code,'url_access_denied');
  assert.equal(classifyGenerationError({status:429}).code,'ai_rate_limited');
  assert.equal(classifyGenerationError({status:503}).code,'ai_server_error');
  assert.equal(classifyGenerationError({constructor:{name:'APIConnectionTimeoutError'}}).code,'ai_timeout');
});
