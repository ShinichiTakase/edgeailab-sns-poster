# 内部仕様: Phase 4B 配備・Rollback準備

## Write freeze

既定sentinelはコンテナ内の `/run/edgeailab-sns-poster-write-freeze`。image内では共有data mountの `/app/data/.write-freeze` を指すsymlinkにする。これによりAPIコンテナでsentinelを作成した後に起動するone-shot containerも同じfreeze状態を見る。存在中はHTTPのPOST/PUT/PATCH/DELETE、OAuth経路、callback、GETで状態を変更するメール認証を503で拒否する。read-only GETは継続する。Stripe webhookもraw body処理・署名検証・ledger更新より前に503を返す。

cron/one-shot serviceは `writeFreezeGuardedRunner.js` を必ず経由する。sentinel存在中は子scriptを起動せず終了コード75とする。sentinelパスはテスト時のみ `SNS_POSTER_WRITE_FREEZE_PATH` で一時領域へ変更できる。

## Reverse writer

`reverseProductionCli.js` はdry-runを既定とし、`--apply`指定時だけ書き戻す。baseline bundleとbaseline manifestは必須。各source IDについて現在値がbaselineまたは既にtargetと一致する場合だけ処理し、それ以外は競合としてwrite前に停止する。

operation manifestはID、operation、expected/target hash、状態、件数、ID集合hashだけを保持し、本文・token・password等を含めない。microCMSはID指定PUT/DELETE、legacy JSONは同一directoryの一時ファイルへ0600で書き、file fsync、rename、directory fsyncの順に置換する。部分失敗後の再実行では適用済みのIDをhashで識別し、残りだけを実行する。

## Compose候補

`deploy/phase4b/docker-compose.sqlite.override.yml` は本番Composeへまだ適用しない候補ファイル。全sns-poster serviceで、承認済みGit tag由来の単一image tag、`/app/data` mount、production暗号鍵env fileを共有する。imageは次のように一度だけbuildする。

```bash
docker build \
  --build-arg APP_REVISION="$GIT_REVISION" \
  --build-arg APP_VERSION="$RELEASE_TAG" \
  -t "edgeailab/sns-poster:$RELEASE_TAG" \
  /opt/project/edgeailab.net/sns-poster
```

Dockerfileはlockfileを使う `npm ci --omit=dev` で依存を固定し、OCI revision/version labelと同名の環境情報を保持する。Compose適用前に全serviceのimage、build無効化、data mount、guarded commandをrender済みconfigで検証する。
