# 内部仕様: SQLiteデータ基盤

## 切替

`SNS_POSTER_DATA_SOURCE` は `microcms`（既定）または `sqlite` を明示指定する。未指定は現行本番互換の `microcms`。未知の値、SQLiteパス未設定、暗号鍵未設定、migration不足は起動エラーとし、microCMSへ自動fallbackしない。

SQLiteモードでは `SNS_POSTER_SQLITE_PATH`、`OAUTH_TOKEN_KEY_VERSION`、`OAUTH_TOKEN_KEYS_JSON` が必要。production migrationはアプリ起動時に自動実行しない。

## 通知値

`schedules.notify_email` は必須。旧 `scheduled_posts` に存在しなかった `notify_email` はNULLのまま移行する。schedule由来投稿はschedule設定を参照し、one-shotのNULLは従来動作どおり通知有効として解決する。

## 予約投稿job

状態は `pending -> processing -> sent -> done`。安全に再試行できる送信前エラーは `failed`、SNS要求開始後に成否を確定できない障害は `ambiguous`、未送信取消は `canceled` とする。

claimはSQLite transaction内の条件付きUPDATEで1 runnerだけが取得する。`request_started_at`より前にleaseが失効したjobはpendingへ戻せる。要求開始後のlease失効はambiguousへ移し、自動再投稿しない。Threads/Instagramのcontainer IDは作成直後に保存し、保存済みIDがある場合はcontainerを再作成しない。

## Effect

SNS成功と外部投稿IDの保存後に `posting_log`、`trial_post_count`、`stripe_meter`、`email`、`notification` をledgerで処理する。posting logとledger作成はtransaction内。ローカルeffectは状態変更と同じtransactionで処理する。Stripe Meterはjob由来のidempotency keyをStripeへ渡す。メール送信中のcrashはambiguousとし、自動二重送信しない。sent以降はSNS APIを再度呼ばない。

## OAuthと監査

OAuth token/state/payloadはAES-256-GCMで暗号化し、鍵versionだけをDBへ保存する。鍵本体は環境変数で管理する。OAuth stateは条件付きUPDATEにより一度だけ消費できる。

業務writeは同一transaction内で `change_journal` にtransaction ID、entity、operation、before/after、時刻を記録する。token、password、secret、ciphertext等はjournalで `[REDACTED]` に置換する。

監査対象は `src/data/writeCoverageManifest.js` で全write APIをA（change journal）、B（job attempt/effect等の専用ledger）、C（一時的・技術的データ）に分類する。Aの19テーブルはmigration 004のINSERT/UPDATE/DELETE triggerで記録し、対象更新がrollbackされた場合はjournalもrollbackする。journal JSONにはpassword hash、token hash、OAuth ciphertext等の秘密列を含めない。

## 隔離HTTP検証

`src/index.js` は `createApp()` と `startServer()` を分離し、テストでは一時SQLite DBを使って実HTTPサーバーを起動できる。テスト中のOAuth/SNS/effectはstubとし、microCMS、legacy業務JSON、実SNS、Stripeへの接続を監視して0件であることを検証する。ログ出力先はテスト時のみ `SNS_POSTER_LOG_DIR` で一時領域へ変更できる。

## Backup / restore

WALファイルの単純copyは禁止し、SQLite Online Backup APIを使う。backup manifestのSHA-256と `PRAGMA integrity_check` を検証する。restoreは既存DBを上書きせず新規パスへ復元し、検証後に運用手順で切り替える。詳細は `SQLite運用手順.md`。

## Phase 5: SQLite-only runtime（2026-10-07）

- Production runtimeは `SNS_POSTER_DATA_SOURCE=sqlite` の明示を必須とする。未設定、空文字、未知値、`microcms` は起動エラーであり、暗黙fallbackは行わない。
- API、OAuth、認証、課金、scheduler、retry、materializer、全batchの構造化業務データはSQLiteだけを参照・更新する。
- microCMS client、export/import、reverse writerはmigration・rollback用ツールとしてのみ保持し、通常runtimeからは選択できない。
- legacy `json/` は移行証跡・rollback archiveとして保持する。通常runtimeの業務データ参照・更新には使用しない。
- 管理統計cacheは `admin_stats_cache` に保存する。一般runtime logは `/app/logs` に保存し、SQLite `audit_logs` は業務監査用途として区別する。
- SNS連携整合性の日次監査はSQLiteの `customers` / `social_accounts` と暗号化tokenの復号可能性を検査する。外部SNS APIおよびlegacy token JSONは参照しない。
