# 内部仕様: SNS連携

最終更新日: 2026-08-25（更新: 連携解除時の未実行予約投稿キャンセルを追加）
コード参照: sns-poster/src/routes/snsConnections.js, facebook.js, instagram.js, threads.js,
x.js, sns-poster/src/lib/tokenStore.js, sns-poster/src/lib/scheduledPostStore.js,
sns-poster/src/middleware/snsConnectionGuard.js,
sns-poster/src/lib/snsConnectionModeConfig.js, sns-poster/config/snsConnectionMode.json,
sns-poster/src/lib/planLimitsConfig.js, sns-poster/config/planLimits.json

## APIエンドポイント一覧

| メソッド | パス | 認証 | 概要 |
|---|---|---|---|
| GET | /api/sns-connections | requireAuth | 連携状況取得 |
| POST | /api/sns-connections/:platform/disconnect | requireAuth, blockViewerRole | 連携解除 |
| GET | /oauth/facebook/start | requireAuth, blockExpiredTrial, requireSnsConnectionAvailable | OAuth開始 |
| GET | /oauth/facebook/callback | 不要 | OAuthコールバック |
| POST | /api/facebook/data-deletion-callback | 不要（署名検証） | Meta必須のデータ削除コールバック |
| GET | /oauth/instagram/start | 同上 | OAuth開始 |
| GET | /oauth/instagram/callback | 不要 | OAuthコールバック（アカウント切替判定含む） |
| POST | /api/instagram/confirm-switch | requireAuth | アカウント切替の確定 |
| POST | /api/instagram/data-deletion-callback | 不要（署名検証） | 同上 |
| POST | /oauth/instagram/deauthorize | 不要 | 受信ログのみの最小実装（要確認: 未実装に近い） |
| GET | /oauth/threads/start | requireAuth, blockExpiredTrial, requireSnsConnectionAvailable | OAuth開始 |
| GET | /threads/callback | 不要 | OAuthコールバック（パスが`/oauth/`プレフィックス無しで非対称） |
| POST | /threads/deauthorize | 不要 | 受信ログのみ |
| POST | /threads/data-deletion | 不要（署名検証） | 同上 |
| GET | /oauth/x/authorize | requireAuth, blockExpiredTrial, requireSnsConnectionAvailable | OAuth開始（パスが`authorize`で他3種と非対称） |
| GET | /oauth/x/callback | 不要 | OAuthコールバック |

## GET /api/sns-connections

各プラットフォーム（facebook/instagram/threads/x）について
`{ connected, available, accountName?, pages?(facebookのみ) }`を返す。
`available`は`isPlatformAvailable`（Dev Mode許可リスト判定）。
レスポンス全体: `{ plan, maxConnections, connectedCount, platforms }`。

**この判定ロジックは`snsConnectionGuard.js`（OAuth開始route側のサーバーサイドゲート）と
必ず一致させる必要がある**、とコード内コメントに明記（クロスファイルの整合性契約）。

## POST /api/sns-connections/:platform/disconnect

`blockViewerRole`適用（閲覧者は403）。`tokenStore.deletePlatformTokensBySlug`で削除、
未連携なら404 `not_connected`。成功時、専用ログファイル（`sns-connections.log`）に
監査ログを記録する（**この監査ログは2026-08-22に新規追加**。それまで連携解除操作には
一切の記録が無く「本当に削除ボタンを押したのか」を事後確認できなかった、とコメントに
明記）。

**未実行予約投稿のキャンセル（2026-08-25追加）**: トークン削除に成功した直後、
`scheduledPostStore.listPendingByCustomerAndPlatform(customerCode, platform)`で
その顧客・そのプラットフォーム宛ての`status=pending`な`scheduled_posts`を取得し、
`deleteScheduledPost`で1件ずつ順次削除する（microCMS書き込み429対策として本機能内の
他箇所と同じ「1件ずつ順次処理」パターンを踏襲。アカウント解約時の
`cancelScheduledJobsForCustomer`・スケジュール一時停止/削除時の
`cancelPendingGeneratedPosts`と同系統だが、それらと違い「顧客×1プラットフォーム」で
絞り込む点が異なる）。

- 修正前は連携解除してもpending予約が一切キャンセルされず、トークンが無いまま
  `scheduledPostExecutor.js`の実行時に`throw new Error("not_connected")`で失敗し、
  再試行（最大3回）を経て最終的に`status="failed"`のまま残るだけだった（無駄な失敗
  ログ・再試行の発生、ユーザーからは投稿一覧に失敗のまま予約が残り続けて見える）
- 対象は「スケジュール投稿（post_schedules）由来」「ワンショット投稿の予約投稿由来」の
  両方（`listPendingByCustomerAndPlatform`は`source_schedule_id`を条件に含めないため）
- キャンセル処理自体が例外を投げても、連携解除（トークン削除）はロールバックしない
  設計（`try/catch`で握りつぶしログのみ）。連携解除という主操作の成否を、副次的な
  後始末処理の成否に引きずられさせないため
- レスポンスに`canceledScheduledPostCount`を追加（フロント側は現状未使用。将来UIで
  「◯件の予約投稿もキャンセルされました」と案内する際に使える）
- **post_schedules（スケジュール設定）自体の`platforms`からの除去、およびcronによる
  新規`scheduled_posts`生成の抑止は行っていない**（対応範囲外、要確認事項参照）。
  そのプラットフォームを含む`post_schedules`が稼働中のままなら、翌日以降
  `scheduleMaterializer.js`が再びそのプラットフォーム宛ての`scheduled_posts`
  （status=pending）を生成し、実行時に同じ`not_connected`失敗を繰り返す
- テスト: `src/routes/snsConnections.test.js`（`node --test`。tokenStore・
  scheduledPostStoreをすべてフェイクに差し替えた統合テスト。「対象プラットフォームの
  pendingのみキャンセルされ他プラットフォームは影響を受けない」「未連携なら404で
  キャンセル処理自体が走らない」「閲覧者は403」等を検証）

## OAuthフロー（4プラットフォーム共通の骨格・相違点）

### 開始（start/authorize）

`requireAuth` → `blockExpiredTrial` → `requireSnsConnectionAvailable(platform)`の順で
ミドルウェアを通す。`state`（ランダム値）を発行しpkceStore（TTL付きmap）に
`{slug}`（Xのみ`+codeVerifier`も）を保存してからプロバイダの認可URLへリダイレクト。

**ルートパスの非対称性（要確認・現状のまま記載）**:
- Facebook/Instagram/Threads: `/oauth/{platform}/start`
- X: `/oauth/x/authorize`（`start`ではない）
- コールバックもThreadsのみ`/threads/callback`（`/oauth/`プレフィックス無し）、他は
  `/oauth/{platform}/callback`

### コールバック共通の流れ

1. `code`/`state`/エラーパラメータの検証（不正なら`ERROR_HTML`「エラーが発生しました。
   担当者にご連絡ください。」）
2. `pkceStore.take(state)`で一度きり消費
3. 短期トークン→長期トークンの交換
4. プロフィール取得（読み取り疎通確認も兼ねる）
5. `findDuplicateOwner(platform, identifiers, slug)`で他顧客が既に同一アカウントを
   連携済みでないか確認。重複していれば`/upgrade.html?reason=duplicate_account`へ
   リダイレクト（エラーページを出さず静かにリダイレクト）
6. `savePlatformTokens`でトークン保存、成功ページ表示

### プラットフォームごとの相違点

**Facebook**: Facebook Login for Business（`config_id`ベース、生スコープ指定ではない）。
コールバックで管理ページ一覧を取得し、各ページに対し`GET /{page.id}?fields=name`で
疎通確認（`verifyPages`）。全ページ失敗なら400。保存形式は`pages: [{pageId, pageName,
pageAccessToken}]`（Facebookのみaccess_tokenがトップレベルに無く、ページごとに持つ）。

**Instagram**: スコープに`instagram_business_content_publish`を明示的に含める必要が
ある（自動では付与されないとコメントに明記）。**アカウント切り替え確認フロー**が
唯一の特徴: 既存連携と異なるアカウントで再認証した場合、即座に上書きせず`pkceStore`に
一時保存し`POST /api/instagram/confirm-switch`での明示確認を要求する。この設計は
**2026-08-21に実際に発生した事故**（連携先が別アカウントへ差し替わった状態のまま
予約投稿が実行され、意図した顧客アカウントに投稿が反映されなかった）への対策として
導入されたもの（コード内コメントに具体的に明記）。保存形式に`permissions`フィールドを
持つのはInstagramのみ。

**Threads**: スコープ`threads_basic,threads_content_publish`。`refresh_token`を
保存しない（長期トークンの更新は同一access_tokenの再交換フローで行う設計、
CLAUDE.md記載の`refreshThreadsTokens.js`と整合）。

**X**: PKCE必須（`code_challenge`/`code_verifier`）。スコープ
`tweet.read tweet.write users.read offline.access media.write`。
`media.write`は2026-08-21追加（記事画像の直接添付に必要）。**このスコープ追加前に
連携済みのアカウントは、refresh tokenだけでは新スコープが付与されないため、
画像添付機能を使うには完全な再連携（OAuthフローのやり直し）が必要**（コメントに明記）。
トークン交換は、まずBasic認証ヘッダーで試し、プロバイダがエラーを返したら
client_secretをボディに含める方式にフォールバックする2段構え（Xの挙動が一定しない
ことへの防御、とコメントに明記）。保存形式に`refresh_token`を持つのはXのみ。

## Meta系のデータ削除コールバック（Facebook/Instagram/Threads共通パターン）

`signed_request`（HMAC-SHA256署名付きbase64url JSON）を`crypto.timingSafeEqual`で
検証。成功時、対象プラットフォームの`user_id`に一致する全顧客のトークンを削除し
（`deletePlatformTokensByUserId`、slug横断検索）、Meta規定のレスポンス形式
`{ url, confirmation_code }`を返す。

## 未実装に近い箇所（2026-08-22レビュー済み・対応不要と判断）

`POST /oauth/instagram/deauthorize`・`POST /threads/deauthorize`は、受信内容を
ログに記録するだけの最小実装。コード内コメントに明記: 「Instagram Business Login の
Deauthorization callbackがsigned_requestを送ってくるかJSON bodyかは未確認
（2026-08-11時点）。まずは受信内容をそのままログに残す最小実装とし、実際の呼び出しを
確認した上で必要ならparseSignedRequestを適用する。」

**2026-08-22調査結果**: Instagram機能導入以降（2026-08-10〜、約12日分）の
`instagram.log`・`threads.log`（OAuthコールバックとリフレッシュcronが共有する同一
ログファイル）を確認したが、`deauthorize`関連の受信ログは一件も無かった。実際の連携
実績も社内テストアカウント（edgeai_lab, shin_tks818, biza3cp70）のみで、
Facebook/Instagram/ThreadsはいずれもMeta審査上のDev Mode制限（許可リストの1
テストアカウントのみ利用可）が掛かっているため、一般ユーザーによる連携解除
（＝Metaのdeauthorizeコールバック発火）が起きる機会自体がほぼ無い状況にある。
実際の呼び出しが無いままsigned_requestのパース実装を書いても実データで検証できず
誤実装のリスクがあるため、**一般公開（Meta審査通過）のタイミングで実際のペイロードを
確認しながら実装する方針とし、現時点では対応を見送った**。

## src/lib/tokenStore.js（永続化層）

- 保存先: `json/client_tokens.json`（フラットJSONファイル、`{slug:{platform:entry}}`）。
  **DBではなくファイルベースの暫定実装**（CLAUDE.mdにも明記。クライアント数増加時は
  DB移行を検討する前提）。ファイルロック機構は無く、同時書き込みへの防御はされていない
- `findDuplicateOwner`: Facebookは`pages[].pageId`の配列比較、他は`user_id`の直接比較
- `accountNameFor`: 投稿ログの`account_name`表示にも使う共通ロジック
  （Facebookは全ページ名をカンマ区切り連結、他は`username || user_id`）

## プラットフォームごとの保存フィールド

| プラットフォーム | 保存フィールド |
|---|---|
| facebook | user_id, pages:[{pageId,pageName,pageAccessToken}], updated_at |
| instagram | user_id, username, access_token, token_expires_at, permissions, updated_at |
| threads | user_id, username, access_token, token_expires_at, updated_at |
| x | user_id, username, access_token, refresh_token, token_expires_at, updated_at |

## middleware/snsConnectionGuard.js（requireSnsConnectionAvailable）

OAuth開始route専用のサーバーサイドゲート。2段階チェック:
1. Dev Mode許可リスト（`isPlatformAvailable`）— 不許可なら
   `/onboarding.html?snsError=coming_soon&platform=X`へリダイレクト
2. プラン接続数上限（未連携プラットフォームのみチェック） — 超過なら
   `/onboarding.html?snsError=limit_reached&platform=X&max=N`へリダイレクト

この判定結果は`GET /api/sns-connections`の応答と一致させる契約になっている
（コメントに明記、クライアント側は結果を信頼するのみでサーバー側ロジックの重複実装は
していない）。

## snsConnectionModeConfig.js + config/snsConnectionMode.json

```json
{
  "facebook": { "mode": "dev", "allowedSlugs": ["biza3cp70"] },
  "instagram": { "mode": "dev", "allowedSlugs": ["biza3cp70"] },
  "threads": { "mode": "dev", "allowedSlugs": ["biza3cp70"] },
  "x": { "mode": "live" }
}
```
`mode: "dev"`のプラットフォームは`allowedSlugs`に含まれる顧客のみ利用可能。
毎回ディスクから読み直すためキャッシュなし（運用側がコード変更なしにdev→live切替可能）。

**現状（2026-08-22）、Facebook・Instagram・Threadsは全てdevモードでテスト顧客1件
（`biza3cp70`）にのみ許可されており、Xのみliveで一般公開されている。**

## planLimitsConfig.js + config/planLimits.json

```json
{ "basic": 1, "standard": 3, "advanced": 5 }
```
ダッシュボードの「ご利用の流れ」コピーはこの値をハードコードして表示しており、
本設定ファイルとは連動していない（設定変更時は手動でHTML側も更新する必要がある）。

## 外部SaaS連携

- Meta Graph API（Facebook/Instagram/Threads、それぞれ別ドメイン: graph.facebook.com系,
  graph.instagram.com, graph.threads.net）
- X API v2（api.x.com、OAuth2 PKCE）

## エッジケース・注意点

- ルートパスの非対称性（start/authorize、callbackのプレフィックス有無）は各プラット
  フォームの実際の登録済みredirect_uriに紐づく本番URLのため、修正時は要注意
- Instagramのアカウント切り替え確認フローは実際の事故を受けて追加された唯一の例外的
  ガード。他3プラットフォームは再認証時に無確認で即座に上書きする
- 連携解除時のpending予約キャンセル（上記）は「今ある予約」のみが対象で、
  post_schedules定義自体は変更しない。そのプラットフォームを含むスケジュールが
  稼働中のまま残っていると、翌日以降のmaterializerが同プラットフォーム宛ての
  予約を再生成し、実行時に`not_connected`で失敗する状態が繰り返される（アカウント
  解約時は`customers.status="canceled"`を`scheduleMaterializer.js`のガードで
  検知して新規生成自体を止めているが、SNS連携解除だけでは顧客ステータスは変化しない
  ため同じ安全策が効かない）。恒久対応するなら、`scheduleMaterializer.js`の生成前に
  `tokenStore.getConnectedEntry`で該当プラットフォームの接続有無を確認するガードを
  追加するか、連携解除時に該当プラットフォームを含む`post_schedules.platforms`から
  除去する処理が必要
