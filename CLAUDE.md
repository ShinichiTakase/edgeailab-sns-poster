## 運用環境
回答は、すべて日本語で行う

## 仕様書の同期（必須）
`sns-poster/docs/` に外部仕様書（`外部仕様_*.md`）と内部仕様書（`内部仕様_*.md`）を
機能ごとに配置している。**仕様変更・機能追加を行った場合は、必ず該当する仕様書
（存在しなければ新規作成）にその内容を反映すること。** コード変更のみで仕様書を
更新しないまま作業を完了しないこと。

このプロジェクト（sns-poster）は本番環境。アプリコードはこのディレクトリにあるが、
実際のコンテナ定義（VIRTUAL_HOST/nginx-proxy連携含む）は
`/opt/project/deploy/xserver-vps/docker-compose.yml` に集約されている
（xsvps-nginx-proxy / xsvps-acme が同ホストで唯一稼働しており、
このプロジェクト単独ではnginx-proxy/acme-companionを立てない）。

## デプロイ手順（必須）
コードを変更した場合、以下の順で必ず実行すること：
1. ローカル編集の反映
2. `cd /opt/project/deploy/xserver-vps && docker compose build sns-poster`
   （このディレクトリのdocker-compose.ymlではなく、中央composeを再ビルドする）
3. `docker compose up -d sns-poster`
4. 動作確認（`docker compose logs -f sns-poster`）

## トライアル期間（内部値と表示値の分離）
`customers.trialEndsAt`（DB上の値）は、顧客に案内する「表向き30日」ではなく
**33日**（30日 + 3日の内部バッファ）で設定される（[src/routes/auth.js](src/routes/auth.js)の
`TRIAL_DAYS`・`TRIAL_INTERNAL_BUFFER_DAYS`参照）。表向き30日ぎりぎりに決済登録すると
Stripe Checkout Sessionの`trial_end`制約（現在時刻より2日超先が必須、実測済み）に
抵触してしまうため、常に3日超の余裕を内部的に確保している。

アクセス制御・請求予測（`billing.js`）・トライアル終了リマインドcron・Stripe
Checkoutの`trial_end`設定は、この33日基準のtrialEndsAtをそのまま使う（意図した挙動）。
ダッシュボード等の「残り◯日」表示だけは、`GET /api/auth/me`が返す
`trialDisplayEndsAt`（バッファを差し引いた表向きの終了日時）を使うこと。
サポート対応時にDB上の値を見て「30日のはずなのに33日になっている」と
混乱しないよう、この関係性を覚えておくこと。

## データ永続化
`json/client_tokens.json` はクライアントごとのSNSトークン置き場。
クライアント数が増えたらDB移行を検討する前提の暫定実装（[src/lib/tokenStore.js](src/lib/tokenStore.js)参照）。

## Instagramトークンの定期リフレッシュ（cron）
`sns-poster-instagram-refresh`（[src/scripts/refreshInstagramTokens.js](src/scripts/refreshInstagramTokens.js)）は
常駐サービスではなく、cronからの手動起動を想定した`profiles: manual`サービス。
実際のcrontab登録は手動実施（コード側の対応は不要）。登録例：

```
0 3 * * * cd /opt/project/deploy/xserver-vps && docker compose run --rm sns-poster-instagram-refresh
```

## Threadsトークンの定期リフレッシュ（cron）
`sns-poster-threads-refresh`（[src/scripts/refreshThreadsTokens.js](src/scripts/refreshThreadsTokens.js)）も同様に
`profiles: manual`サービス。実際のcrontab登録は手動実施（コード側の対応は不要）。登録例：

```
0 3 * * * cd /opt/project/deploy/xserver-vps && docker compose run --rm sns-poster-threads-refresh >> /var/log/threads-refresh.log 2>&1
```

## トライアル終了リマインドメール（cron）
`sns-poster-trial-reminder-check`（[src/scripts/trialReminderCheck.js](src/scripts/trialReminderCheck.js)）も同様に
`profiles: manual`サービス。トライアル終了が残り3日以内（`REMINDER_WINDOW_DAYS`）かつ
`customers.trialReminderSent`が未送信の顧客にリマインドメールを送信する（1顧客1回のみ）。
実際のcrontab登録は`/etc/cron.d/edgeailab-net-trial-reminder-check`に日次（毎日5時）で
実施済み（2026-08-22追加。それ以前はdocker-composeサービス定義自体が存在せず、
本番で一度も実行されていなかった）。登録例：

```
0 5 * * * cd /opt/project/deploy/xserver-vps && docker compose run --rm sns-poster-trial-reminder-check
```

## Instagram Reels投稿の削除不可
Instagram Graph APIは公開済みメディアの削除エンドポイントを提供していない
（`DELETE /{media-id}`は`Unsupported delete request`エラーになる。実機検証済み、
2026-08-19）。動画生成機能（[src/lib/videoGenerator.js](src/lib/videoGenerator.js)・
[postReel](src/lib/instagramPoster.js)）で誤って投稿してしまった場合も、このAPI経由では
取り消せず、顧客自身がInstagramアプリ側から手動削除する以外に手段がない。
2026-08-22、edgeailab.net/faq.htmlのQ21にこの旨を追記済み。
