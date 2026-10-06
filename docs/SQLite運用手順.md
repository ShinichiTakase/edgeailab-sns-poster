# SQLite運用手順

## 前提

本番切替までは `SNS_POSTER_DATA_SOURCE=microcms` を維持する。SQLiteモードは `SNS_POSTER_DATA_SOURCE=sqlite`、`SNS_POSTER_SQLITE_PATH=/app/data/sns-poster.sqlite3`、`OAUTH_TOKEN_KEY_VERSION`、`OAUTH_TOKEN_KEYS_JSON` を明示設定した場合だけ有効になる。SQLite障害時のmicroCMSへの自動fallbackはない。

## Backup

稼働中DBは `node src/db/backupCli.js /app/data/sns-poster.sqlite3 /backup/sns-poster-YYYYMMDDTHHMMSS.sqlite3` でSQLite Online Backup APIを使う。WALファイルの単純copyは使用しない。生成されるmanifestのSHA-256とサイズを確認し、DB本体とmanifestをVPS外の暗号化済み保管先へ転送する。転送処理と保管先資格情報はアプリに組み込まず、ホストのbackup運用で管理する。

## Restore

アプリを停止した切替手順内で、既存DBとは別名を指定して `node src/db/restoreCli.js BACKUP_DB NEW_DB` を実行する。checksum、`PRAGMA integrity_check`、migration version、主要テーブル件数を確認してからパスを切り替える。既存DBへの上書きrestoreは禁止する。

## Rollback

cutover後のwriteは `change_journal` と外部effect ledgerを基にreverse exportする。SNS投稿・Stripe Meter・メールは外部副作用なので、DB rollbackだけで取り消さない。microCMSへ戻す場合はreverse mapperのdry-run、件数・ID照合、差分承認、write停止時間の確保を経て別手順で実施する。
