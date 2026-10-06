# 内部仕様: SNS連携

最終更新日: 2026-09-01（更新: トライアル濫用防止のためのSNS連携履歴チェック
〔sns_history.json〕を追加）
コード参照: sns-poster/src/routes/snsConnections.js, facebook.js, instagram.js, threads.js,
x.js, linkedin.js, sns-poster/src/lib/tokenStore.js, sns-poster/src/lib/snsHistoryStore.js,
sns-poster/src/lib/trialHistoryGuard.js, sns-poster/src/lib/pkceStore.js,
sns-poster/src/lib/scheduledPostStore.js, sns-poster/src/middleware/snsConnectionGuard.js,
sns-poster/src/lib/snsConnectionModeConfig.js, sns-poster/config/snsConnectionMode.json,
sns-poster/src/lib/planLimitsConfig.js, sns-poster/config/planLimits.json,
sns-poster/src/scripts/backfillSnsHistory.js, edgeailab.net/onboarding.html

## APIエンドポイント一覧

| メソッド | パス | 認証 | 概要 |
|---|---|---|---|
| GET | /api/sns-connections | requireAuth | 連携状況取得 |
| POST | /api/sns-connections/:platform/disconnect | requireAuth, blockViewerRole | 連携解除 |
| POST | /api/sns-connections/confirm-trial-history-reconnect | requireAuth, blockViewerRole | SNS連携履歴ヒット時の確認ダイアログ確定（2026-09-01追加） |
| GET | /oauth/facebook/start | requireAuth, blockExpiredTrial, requireSnsConnectionAvailable | OAuth開始 |
| GET | /oauth/facebook/callback | 不要 | OAuthコールバック |
| POST | /api/facebook/data-deletion-callback | 不要（署名検証） | Meta必須のデータ削除コールバック |
| GET | /oauth/instagram/start | 同上 | OAuth開始 |
| GET | /oauth/instagram/callback | 不要 | OAuthコールバック（アカウント切替判定・SNS連携履歴判定含む） |
| POST | /api/instagram/confirm-switch | requireAuth | アカウント切替の確定（SNS連携履歴確認との合成フローあり、後述） |
| POST | /api/instagram/data-deletion-callback | 不要（署名検証） | 同上 |
| POST | /oauth/instagram/deauthorize | 不要 | 受信ログのみの最小実装（要確認: 未実装に近い） |
| GET | /oauth/threads/start | requireAuth, blockExpiredTrial, requireSnsConnectionAvailable | OAuth開始 |
| GET | /threads/callback | 不要 | OAuthコールバック（パスが`/oauth/`プレフィックス無しで非対称） |
| POST | /threads/deauthorize | 不要 | 受信ログのみ |
| POST | /threads/data-deletion | 不要（署名検証） | 同上 |
| GET | /oauth/x/authorize | requireAuth, blockExpiredTrial, requireSnsConnectionAvailable | OAuth開始（パスが`authorize`で他3種と非対称） |
| GET | /oauth/x/callback | 不要 | OAuthコールバック |
| GET | /oauth/linkedin/start | requireAuth, blockExpiredTrial, requireSnsConnectionAvailable | OAuth開始 |
| GET | /oauth/linkedin/callback | 不要 | OAuthコールバック |

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
- post_schedules（スケジュール設定）自体の`platforms`からの除去は行っていない
  （プラットフォームを再連携すれば自動的に元の設定のまま復活する、という挙動を
  維持するため意図的にそのまま）。ただし翌日以降の再生成自体は下記の恒久対策で
  止まるため、実害は無い
- テスト: `src/routes/snsConnections.test.js`（`node --test`。tokenStore・
  scheduledPostStoreをすべてフェイクに差し替えた統合テスト。「対象プラットフォームの
  pendingのみキャンセルされ他プラットフォームは影響を受けない」「未連携なら404で
  キャンセル処理自体が走らない」「閲覧者は403」等を検証）

## 恒久対策: scheduleMaterializer.jsでの接続状況ガード（2026-08-25追加）

上記のdisconnect時キャンセルだけでは「今ある予約」しか消せず、そのプラットフォーム
を含む`post_schedules`が稼働中のまま残っていると、翌日以降のmaterializerが同じ
プラットフォーム宛ての`scheduled_posts`を再生成し、実行時に`not_connected`失敗を
繰り返してしまう問題が残っていた。これに対する恒久対策として、
`src/scripts/scheduleMaterializer.js`の生成ループに接続状況チェックを追加した。

- スケジュールごとに`tokenStore.getConnectedEntry(schedule.customer_code)`を1回だけ
  呼び出し（`i`ループの外、`platforms`ループの外側で計算してキャッシュ）、プラット
  フォームごとのループ内で`if (!connectedEntry[platform]) continue;`により、
  未接続のプラットフォームだけを個別にスキップする（テキスト未入力時のスキップ
  `if (!content.trim()) continue;`と同じ「1プラットフォームだけ静かにスキップする」
  パターンを踏襲）
- スケジュールが複数プラットフォームを対象にしている場合、連携解除したプラットフォーム
  分のみ生成をスキップし、**接続が残っている他のプラットフォーム分は通常通り生成される**
  （スケジュール全体を止めるのではなく、プラットフォーム単位で止める設計）
- `post_schedules.platforms`自体は書き換えないため、後日そのプラットフォームを
  再連携すれば、次回materialize時から自動的に生成が再開する（ユーザー側でスケジュール
  設定を再入力する必要はない）
- スキップされた分だけ生成数が減るが、`last_materialized_dt`の更新・
  `round_robin_index`の消費は従来通り行われる（テキスト未入力時のスキップと同じ扱い。
  1プラットフォームだけ未接続でも、その日のスケジュール全体が「未生成」のまま
  取り残されることはない）
- アカウント解約時の`isCanceled`ガード（顧客単位で生成自体を止める）と同種の設計だが、
  こちらは「顧客×プラットフォーム」単位で止める点が異なる
- 検証: 本番環境で`docker compose run --rm sns-poster-schedule-materializer`を
  手動実行し、実在する稼働中スケジュール5件に対してエラー無く完了することを確認済み
  （`last_materialized_dt`により当日分は冪等スキップされるため、本番データに対して
  安全に手動実行できる）。cron専用スクリプトのため`node --test`によるモック化した
  自動テストは追加していない（既存の他cronスクリプトにも同様のテストは無い）

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
5.5. `trialHistoryGuard.checkTrialHistoryHit(platform, identifiers, slug)`で
   SNS連携履歴（`sns_history.json`）を確認。ヒットすれば即保存せず確認ダイアログへ
   （後述「SNS連携履歴によるトライアル濫用防止」参照。2026-09-01追加）
6. `savePlatformTokens`でトークン保存、`trialHistoryGuard.recordConnectionForHistory`で
   `sns_history.json`へ記録、成功ページ表示

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

## Instagramリール投稿とフィード（グリッド）二重掲載の防止（2026-08-26追加）

`postReel`（[src/lib/instagramPoster.js](../src/lib/instagramPoster.js)）でメディアコンテナを
作成する際、Meta Graph APIの`share_to_feed`パラメータを省略するとデフォルトで`true`扱いに
なり、リールタブだけでなくプロフィールのグリッド（フィード）にも自動的に投稿されてしまう
（実機で確認: 2026-08-26、顧客からの報告）。動画付きのスケジュール投稿は
[scheduledPostExecutor.js](../src/lib/scheduledPostExecutor.js)の`postToPlatform`から
`postReel`のみが呼ばれておりコード側の二重呼び出しではないため、原因はこのAPI
パラメータ未指定によるMeta側のデフォルト挙動だった。`postReel`のリクエストボディに
`share_to_feed: false`を明示することで、リールタブのみに投稿されるよう修正した。

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

### 孤児化トークンによるduplicate_account誤検知（2026-08-26発生・対策済み）

`client_tokens.json`はcustomersレコードの削除・状態変更と連動しない独立ストア。
正規の解約導線（`POST /api/account/cancel`）は`deletePlatformTokensBySlug`で
トークンも連動して削除するが、**microCMS管理画面からcustomersレコードを直接削除
した場合はトークンだけが孤児化して残る**。孤児化したslug（実体は`req.customer.id`）が
`findDuplicateOwner`に居座り続けると、同じSNSアカウントを正しい持ち主が再連携
しようとしても「他アカウントが既に使用中」と誤判定され、`/upgrade.html?reason=
duplicate_account`へブロックされる（実機発生: 2026-08-26、info@108teaworks.com/
id: k22n7qwhimx。過去にmicroCMS管理画面から直接削除された`id: 108teaworks`の
トークンが残っていたことが原因。手動でslugを付け替えて復旧）。

再発防止として`src/scripts/orphanSnsTokenCheck.js`を追加。`client_tokens.json`の
全slugについてcustomersレコードの実在をmicroCMSに問い合わせ、存在しないslugが
見つかったらログ記録＋メール通知する（自動削除はしない。誤検知で実データを失わない
よう判断と削除は人間が行う）。`docker compose run --rm sns-poster-orphan-sns-token-check`
で日次（毎日5時）起動、実際のcrontab登録は`/etc/cron.d/edgeailab-net-orphan-sns-token-check`
に実施済み。

**根本的な再発防止には、customersレコードの削除は必ずアプリの解約機能
（プロフィールメニュー「解約」、顧客自身のセルフサービス）経由で行い、microCMS管理画面
から直接customersレコードを削除しないこと。** sns-poster自体には運営者向けの管理GUIは
存在しない。

## SNS連携履歴によるトライアル濫用防止（sns_history.json、2026-09-01追加）

### 背景

`client_tokens.json`はcustomerのライフサイクル（解約・SNS連携解除）と運命を共にする
ストアであり、「このSNSアカウントは過去にトライアルで使われたことがある」という
事実がここにしか残らない。そのため、以下の手順でトライアルを無制限に濫用できる
穴があった:

1. メールAでサインアップ→トライアル取得→SNS連携→トライアル消費
   （60通到達 or 33日経過）
2. `POST /api/account/cancel`（解約）または`POST /api/sns-connections/:platform/disconnect`
   （連携解除。**トライアル切れ・未払いでも実行できてしまう**。`blockExpiredTrial`が
   付いていない）でトークンを削除
3. 別メールBで新規サインアップ→まっさらなトライアルを取得
4. メールBから同じSNSアカウントを連携→`findDuplicateOwner`は"今生きているトークン"
   しか見ないため検知できず成功
5. 1〜4を繰り返せば同一SNSアカウントのまま無期限に無料利用できる
   （Facebook/Instagram/Threads/X/LinkedIn全プラットフォームで同一パターンが成立）

対策として、customerのライフサイクルから独立した永続台帳`json/sns_history.json`を
新設し、SNS連携時（OAuthコールバック）にこの台帳と照合してトライアル濫用を
検知・防止する。**disconnect自体にトライアル切れガードを追加する対策案も検討したが、
`POST /api/account/cancel`（正規の解約導線）はトークンを削除する設計自体が意図的
なため、そちらを経由されると同じ穴が残る。「解約・連携解除は自由にできるが、
使い回されたアカウントの再連携でトライアルを検知する」側で対策する方針とした。**

### src/lib/snsHistoryStore.js（永続化層）

- 保存先: `json/sns_history.json`（フラットJSONファイル、`client_tokens.json`と同じ
  ディレクトリ。docker-compose.ymlでは`json/`ディレクトリ自体がbind mountされている
  ため、新規ファイルでも追加のマウント設定は不要）
- キー: `{platform}:{accountId}`（例: `instagram:17841400000000000`）。Facebookのみ
  `pages[].pageId`単位（1顧客が複数ページを連携可能なため）、他4プラットフォーム
  （Instagram/X/Threads/LinkedIn）は`user_id`/`sub`単位
- 値: `{ firstCustomerId, firstConnectedAt }`のみ（アクセストークン等の機微情報は
  一切持たない）
- `findOtherCustomerHit(platform, identifiers, currentCustomerId)`:
  `identifiers`配列（facebookは複数ページ分）のうち、自分以外の顧客が最初に連携した
  記録が残っているものを探す。`tokenStore.findDuplicateOwner`と同じく最初の1件のみ
  返す（facebookで複数ページが同時にヒットしても、連携全体〔全ページ〕を保留対象と
  する粒度で統一）
- `recordNewIdentifiers(platform, identifiers, customerId, connectedAt)`:
  未記録のキーのみ追記する。**既に記録がある場合（自分自身の過去の連携を含む）は
  一切上書きしない**（「最初の連携者・最初の連携日時」を不変の値として扱うため）
- 想定ユーザー数は最大500件のため、DBではなくJSONファイルで十分な性能が出る想定
  （client_tokens.jsonと同じ判断）

### src/lib/trialHistoryGuard.js（判定ロジックの共通化）

facebook.js/instagram.js/threads.js/x.js/linkedin.jsの5ファイル全てから使う共通ヘルパー:

- `checkTrialHistoryHit(platform, identifiers, slug)`: `customerStore.getCustomerById`で
  連携しようとしているcustomerを取得し、**`status === "trial"`の場合のみ**
  `findOtherCustomerHit`を呼ぶ（既に課金中の顧客が過去に使われたアカウントを
  連携する分には問題ないため対象外）。加えて`snsConnectionModeConfig.isKnownTestSlug`
  （後述）に該当するテストアカウントも対象外とし、この場合はヒットしていても
  `null`を返して確認ダイアログを出さない
- `recordConnectionForHistory(platform, identifiers, slug, connectedAt)`:
  `recordNewIdentifiers`を呼ぶだけの薄いラッパー。**こちらは`customer.status`を
  問わず常に記録する**（トライアル中に限定すると、有料顧客が新規連携したアカウントが
  台帳に残らず、将来そのアカウントが解約等で解放された際の再利用チェックが効かなく
  なるため）
- `revokeTrialAfterHistoryReconnect(slug)`: `customerStore.updateCustomer(slug,
  { status: ["active"], trialEndsAt: "" })`。**必ず実際にトークンが保存される
  タイミングと同じ箇所でのみ呼ぶこと**（後述「実行タイミングの制約」参照）。
  `trialEndsAt`も同時に空にする理由: `status`だけ変えて`trialEndsAt`を残すと、
  `edgeailab.net/dashboard.html`の`status==="active"`でも`trialDisplayEndsAt`が
  未来なら「お客様は現在トライアル期間です」と表示する分岐（2026-09-01追加）と
  矛盾する。空にすることで`requiresPaymentRegistration()`が正しく「支払い未登録」
  としてブロックし、ダッシュボードの表示も自然に一致する

### snsConnectionModeConfig.js: isKnownTestSlug（テストアカウント除外）

`config/snsConnectionMode.json`の`allowedSlugs`（Dev Mode許可リスト、後述）を
そのまま流用し、新たな設定ファイルは作らない。動作確認で同じSNSアカウントを
繰り返し連携し直す検証用アカウント（`biza3cp70`・`k22n7qwhimx`・`eagvpvste2cu`）は、
履歴ヒットのたびに確認ダイアログが出ると検証作業に支障が出るため対象外にする。
**ダイアログ判定のみ対象外であり、`sns_history.json`への記録自体は通常通り行われる。**

### 確認ダイアログ（保留フロー）

既存の`pkceStore`（TTL付きmap、10分。単一プロセス運用のためメモリ内で十分。
`src/lib/pkceStore.js`）と、Instagramの「アカウント切替確認」フロー
（`pkceStore.put(switchToken, {...})` → `POST /api/instagram/confirm-switch`）と
同じ設計パターンをそのまま流用している。

- ヒットした場合、コールバックの時点ではトークンを保存せず、取得済みのトークン一式
  （`tokenData`）と識別子（`identifiers`）を`pkceStore`に一時保管する
  （`{slug, platform, tokenData, identifiers}`）。プラットフォーム側の認可自体は
  既に成立済みなので、これを取り消す処理は不要
- `onboarding.html`へ`?trialHistoryReconnect=<token>&platform=<platform>`付きで
  リダイレクトし、`showTrialHistoryConfirm()`（switch-confirm-bannerのCSSクラスを
  そのまま流用した確認バナー）を表示する
- 本文: 「このアカウントは過去に連携されているので、再連携するとトライアルは
  終了します」＋「キャンセル」「連携」の2ボタン
- 「キャンセル」→ 何もしない（`onboarding.html`へ戻るだけ。`pkceStore`のエントリは
  TTLで自然に失効する）
- 「連携」→ `POST /api/sns-connections/confirm-trial-history-reconnect`
  （`snsConnections.js`、5プラットフォーム共通の単一エンドポイント）を呼ぶ

### Instagramのみ発生しうる二重確認の合成

Instagramだけは既存の「アカウント切替確認」フローを持つため、「切替確認」と
「トライアル履歴確認」が同時に必要になるケースがありうる（現在の連携先と別アカウント
に切替、かつ切替先が`sns_history.json`にもヒット。悪用パターンとしてはむしろ典型的）。

`confirm-trial-history-reconnect`エンドポイントは、platform==="instagram"の場合のみ
`getConnectedEntry(slug).instagram`と`tokenData.user_id`を比較し、既存の切替判定
ロジックを再実行する:

- 切替不要（未連携、または同一アカウント）→ その場で`savePlatformTokens`・
  `revokeTrialAfterHistoryReconnect`・`recordConnectionForHistory`を実行し`{ok:true}`
- 切替必要 → **トークン保存もトライアル失効もここでは行わず**、新しい`switchToken`を
  発行して`pkceStore`に`{slug, tokenData, trialHistoryIdentifiers: identifiers}`を
  保存し、`{ok:true, needsSwitchConfirm:true, switchToken, from, to}`を返す。
  フロント（`onboarding.html`）はこれを受けて`?instagramSwitch=...`付きで
  自身をリロードし、**既存の**`showSwitchConfirm()`にそのまま引き継ぐ（新しい
  UIを追加していない）
- `POST /api/instagram/confirm-switch`側は、`pending.trialHistoryIdentifiers`が
  存在する場合のみ、`savePlatformTokens`の直後に`revokeTrialAfterHistoryReconnect`・
  `recordNewIdentifiers`を実行する

### 実行タイミングの制約（重要）

`revokeTrialAfterHistoryReconnect`（トライアル失効）は、**確認エンドポイントの中で
即座に実行してはならない**。Instagramの2段階確認で、1段階目（トライアル履歴確認）の
「連携」を確定した後、2段階目（アカウント切替確認）を「キャンセル」された場合、
何も連携されていないのにトライアルだけを失うバグになるため。

このため、`status: ["active"], trialEndsAt: ""`への更新は、**すべての確認を通過し
実際にトークンが`client_tokens.json`へ保存される処理と全く同じタイミング**
（`savePlatformTokens`呼び出しの直後）でのみ行う。5プラットフォームすべて
（確認が1段階のみのX/Threads/LinkedIn/Facebookと、2段階になりうるInstagram）で
この原則が守られている。

### pkceStore.jsの副作用修正（2026-09-01）

`pkceStore.js`のTTL掃除用`setInterval`が`.unref()`されておらず、このモジュールを
`require`しただけでプロセスが自然終了しなくなる副作用があった。今回`snsConnections.js`
（`confirm-trial-history-reconnect`エンドポイント用）が新たに`pkceStore`を
requireしたことで、`src/routes/snsConnections.test.js`が正常終了せずタイムアウトする
問題が判明し、`.unref()`を追加して修正した（本番の常駐プロセスとしての挙動には
影響しない。テスト・単発スクリプト等の短命プロセスで顕在化する問題だった）。

### 初期投入（バックフィル）

`src/scripts/backfillSnsHistory.js`（一回限りのスクリプト）を導入時に実行し、
既存の`client_tokens.json`の全エントリを`sns_history.json`へ一括投入する。

- `node src/scripts/backfillSnsHistory.js`（引数無し）→ dry-run（投入対象件数の
  確認のみ、書き込みなし）
- `node src/scripts/backfillSnsHistory.js --apply` → 実際に投入
- `recordNewIdentifiers`が未記録のキーのみ追記する設計のため、複数回実行しても
  安全（冪等）。再実行しても既存データは上書きされない
- **既知の限界**: 導入前に既に解約・連携解除済みで`client_tokens.json`から消えて
  しまった過去の連携は、データ自体が残っていないため復元できない

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
  "facebook": { "mode": "live", "allowedSlugs": ["biza3cp70", "k22n7qwhimx", "eagvpvste2cu"] },
  "instagram": { "mode": "live", "allowedSlugs": ["biza3cp70", "k22n7qwhimx", "eagvpvste2cu"] },
  "threads": { "mode": "live", "allowedSlugs": ["biza3cp70", "k22n7qwhimx", "eagvpvste2cu"] },
  "x": { "mode": "live" }
}
```
`mode: "dev"`のプラットフォームは`allowedSlugs`に含まれる顧客のみ利用可能。
毎回ディスクから読み直すためキャッシュなし（運用側がコード変更なしにdev→live切替可能）。

**「allowedSlugs」という名前だが、中身はmicroCMSの`slug`フィールド（`customerStore.js`の
`crypto.randomUUID()`）ではなく、`req.customer.id`（microCMSのコンテンツID。例:
`biza3cp70`・`k22n7qwhimx`）である。** instagram.js/facebook.js/threads.js/x.js/linkedin.js
は全て`const slug = req.customer.id;`という書き方でローカル変数名を「slug」としているが
（token store・`isPlatformAvailable`のキーとして使うのはこの`.id`）、customerレコード上に
実在する`slug`フィールド（UUID）とは別物なので混同しないこと。

このallowedSlugsはアプリ内部のゲートであり、Meta Developer Console側でテストユーザーとして
承認するのとは別に、ここへも顧客の（`.slug`ではなく）`.id`を追加登録しないと`available: false`
のまま「近日公開予定です」表示・連携ボタングレーアウトになる（2026-08-25、
`info@108teaworks.com`（id: `k22n7qwhimx`）がMeta側は承認済みなのにこちらの登録漏れで
連携できない不具合が発生し追加登録。最初`.slug`フィールドの値を登録してしまい直らず、
`.id`だと気づいて登録し直した実例）。

同様に2026-08-25、Meta App Review用のテストアカウント`shin.takase@edgeailab.jp`
（トップレベルcustomer、id: `eagvpvste2cu`、`contactName: "META TEST"`）も
Facebook/Threads/Instagramの連携ボタンがDisableになっていたため追加登録した。
Meta審査（App Review）自体はまだ完了しておらず現在もDevモードのため、
今後の新規サインアップも同様にこのファイルへの手動追加が必要になる
（審査完了後は`mode`を`"live"`に変更すればこの手動追加は不要になる）。

**変更前（2026-08-25）、Facebook・Instagram・Threadsは全てdevモードでテスト顧客3件
（`biza3cp70`、`k22n7qwhimx`、`eagvpvste2cu`）にのみ許可されており、Xのみliveで一般公開されている。**

2026-10-01: onboarding.htmlの連携ボタン有効化の依頼により、Facebook・Instagram・Threadsを`mode: "live"`へ変更。APIの`available`判定とOAuth開始ガードの両方で許可リスト制限を解除する。プラン接続数上限・閲覧者の操作制限は継続する。`allowedSlugs`はトライアル履歴の検証用アカウント判定にも使うため保持する。この設定はアプリ内部の利用可否であり、Meta側の審査状態を変更するものではない。本番反映には別途配備が必要。

2026-10-06: Instagramは外部審査中のため`mode: "dev"`へ戻した。FacebookとThreadsは`live`を維持する。

2026-10-06: InstagramのMeta審査承認を人間が確認したため、`mode: "live"`へ変更し正式提供を開始。Facebook・Threadsも引き続き`live`を維持する。FacebookはFacebook Pageのみ、LinkedInは個人プロフィールのみを提供対象とする。

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
  post_schedules定義自体は変更しない。**2026-08-25時点では、この残課題は
  scheduleMaterializer.jsへの接続状況ガード追加（上記「恒久対策」参照）で解消済み**。
  post_schedules.platformsに連携解除済みのプラットフォームが残っていても、
  そのプラットフォーム分の新規生成だけが継続的にスキップされ、`not_connected`失敗が
  繰り返されることはない
- `POST /api/sns-connections/:platform/disconnect`には`blockExpiredTrial`が
  付いていない（トライアル切れ・未払いでも連携解除自体は実行できる）。これは
  意図的な設計ではなく、上記「SNS連携履歴によるトライアル濫用防止」の穴の一部として
  発見されたもの。disconnect側にガードを追加する対策は取らず、SNS連携履歴
  （`sns_history.json`）側で濫用を検知する方針とした（理由は同セクション参照）
