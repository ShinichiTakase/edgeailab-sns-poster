const test=require('node:test'),assert=require('node:assert/strict');
const {validateReelCaption}=require('./videoGenerator');
test('all animations preserve short Japanese text with readable hold',()=>{for(const a of ['typewriter','endroll','slidein']){const p=validateReelCaption('季節のお知らせ\n最後まで読める文章です。',a);assert.equal(p.lines.join(''),'季節のお知らせ最後まで読める文章です。');assert.ok(p.durationSeconds>=12&&p.durationSeconds<=60);}});
test('long endroll keeps final line; no font shrink',()=>{const text='読みやすい日本語の文章です。'.repeat(18)+'最後の行';const p=validateReelCaption(text,'endroll');assert.equal(p.lines.join(''),text);assert.equal(p.fontSize,60);assert.ok(p.durationSeconds>30);});
test('empty emoji too long and overflowing static text are explicit errors',()=>{for(const t of ['', '😀', 'あ'.repeat(2201)])assert.throws(()=>validateReelCaption(t),e=>!!e.code);assert.throws(()=>validateReelCaption('あ'.repeat(200),'slidein'),/endroll/);});
test('maximum accepted endroll boundary rejects next character',()=>{let n=1;while(true){try{validateReelCaption('あ'.repeat(n),'endroll');n++;}catch{break;}}assert.ok(n>100);assert.ok(validateReelCaption('あ'.repeat(n-1),'endroll').durationSeconds<=60);assert.throws(()=>validateReelCaption('あ'.repeat(n),'endroll'));});
test('explicit blank lines contribute to layout and duration',()=>{const p=validateReelCaption('一行目\n\n最後の行','endroll');assert.deepEqual(p.lines,['一行目','','最後の行']);});

test('stripEmojiFromCaption removes emoji so generated captions pass validation', () => {
  const { stripEmojiFromCaption, validateReelCaption } = require('./videoGenerator');
  const raw = '新作が入荷しました 🎉✨\n今週末だけ特別価格です 🛍️';
  assert.throws(() => validateReelCaption(raw), (e) => e.code === 'reel_emoji_unsupported');
  const cleaned = stripEmojiFromCaption(raw);
  assert.ok(!/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(cleaned));
  assert.equal(cleaned, '新作が入荷しました\n今週末だけ特別価格です');
  assert.doesNotThrow(() => validateReelCaption(cleaned));
  assert.equal(stripEmojiFromCaption('絵文字なし'), '絵文字なし');
  assert.equal(stripEmojiFromCaption(undefined), undefined);
});
