# sns-poster — バックエンド

回答は日本語で行う。

## 環境と本番操作

- 配置先は `/opt/project/edgeailab.net/sns-poster/AGENTS.md`。このディレクトリは静的サイトとは独立したGitリポジトリ。
- XServer VPSの本番兼開発環境。Stripeは本番利用中。親の `AGENTS.md` とこのファイルを読み、既存の `CLAUDE.md` は参考資料として保持する。
- 変更前に既存コード・該当仕様書を確認する。仕様変更や機能追加では `docs/外部仕様_*.md`・`docs/内部仕様_*.md` の該当文書も更新する。
- 読み取り専用調査では変更、package update、migration、build、restart、deploy、ジョブ実行を行わない。
- コード編集だけの依頼を、本番反映・データ変更・実課金・実投稿・メール送信の許可と解釈しない。対象操作への明示的な許可が必要。既に許可された範囲は再確認しない。
- `.env`、`json/client_tokens.json`、認証情報、秘密鍵、顧客データの秘密値を出力・コミットしない。ログにも秘密値や個人情報が含まれ得る。
- 調査目的でアプリモジュールを読み込んだり、スクリプトを実行したりしない。一部GET APIにもStripe更新処理があるため、GETを無条件に読み取り専用と扱わない。
- 既存変更・未追跡ファイルを保護する。共有VPSの他サービスに影響する一括操作を避ける。

## 技術構成・配備

- Node.js、CommonJS、Express。起動入口は `src/index.js`。
- Dockerfileは `node:20-alpine`、ffmpeg、日本語フォント、`TZ=Asia/Tokyo` を指定。起動は `node src/index.js`。
- 中央Composeは `/opt/project/deploy/xserver-vps/docker-compose.yml`。APIサービスは `sns-poster`、コンテナは `xsvps-sns-poster`。
- 共有のnginx-proxy/acmeが存在する。プロジェクト専用の別proxy/acmeを追加しない。
- 確認時点でAPIコンテナのホスト公開ポートはなく、nginxから内部3000番へ転送する。
- Composeの `env_file` はこのプロジェクトの `.env` を参照。ソースのdotenv参照だけで実際の供給方式を判断しない。
- APIコンテナの永続マウントは `json/` → `/app/json`、`uploads/` → `/app/uploads`。ソースのbind mountは確認されていない。
- データはmicroCMSとローカルJSONを併用。`json/` をキャッシュだけのディレクトリとみなして削除しない。
- 各定期ジョブにも個別のbuild定義がある。APIの `sns-poster` だけの再ビルドで全ジョブが更新されると仮定せず、許可されたデプロイ前に各イメージと反映対象を確認する。
- Dockerfileはpackage-lock.jsonをコピーせず `npm install --omit=dev` を実行する構成。再ビルド時の依存再現性は確認事項であり、移行だけを理由に変更しない。

## 投稿先・リリース方針

2026-09-30時点のユーザー確認事項: Xは審査なし、Facebook Page・Threadsは審査通過、Instagramは審査中。Instagram承認後にリリースする。LinkedIn個人プロフィールは審査なしで初回対象、法人ページは審査中で初回対象外。

- 確認済みLinkedIn実装は `openid profile w_member_social` を要求し、投稿者・画像所有者に `urn:li:person:…` を使用する。法人投稿に勝手に拡張しない。
- Facebook予約投稿はPage IDとPageアクセストークンを使用する。個人プロフィール投稿は対象外。
- InstagramはInstagram OAuthを使用。要求scopeはbasic、content_publish、manage_comments、manage_messages、manage_insightsの各 `instagram_business_*`。審査申請・承認された権限との一致は別途確認する。
- 新規登録はGUIのリンクを外しているだけで、直接アクセスとsignup APIは有効。一般の登録を一律停止する実装はない。登録導線や停止方式を依頼なしに変更しない。
- 開発ツールのClaude CodeからCodexへの移行は、アプリのAnthropic APIの置き換えを意味しない。

## 投稿・再試行・課金

- 予約はmicroCMSの `scheduled_posts`。状態は `pending` / `done` / `failed`。
- `scheduleMaterializer.js` が予約を生成し、`scheduledPostRunner.js` と `scheduledPostRetryRunner.js` が共通の `scheduledPostExecutor.js` を使う。
- 確認済み予約投稿の順序は、SNS投稿成功 → `done`保存 → トライアル集計・通知等 → Stripeメーター送信 → 投稿ログ作成。
- 課金イベント送信はSNS投稿成功後の経路にある。投稿失敗に対して課金していると誤記しない。
- 課金イベントや投稿ログの送信失敗は捕捉してログへ記録し、投稿そのものを再試行させない。欠落分の回復経路は未確認。
- SNS投稿成功後に `done` 保存が失敗すると、通常runnerが失敗扱いとして再試行へ回し得る。重複投稿の発生実績は未確認。障害対応で安易に再実行しない。
- 再試行情報は `json/scheduled_post_retries.json`。初回失敗後、3分後以降に最大3回の再試行を管理する。cronの起動時刻に依存し、厳密に3分後の実行を保証しない。
- 確認したcron・起動指定・通常runnerには排他制御が見当たらず、再試行JSONはファイル全体を読み書きする。並行実行時の安全性は未検証。ロックや冪等性を全体として保証済みと扱わない。
- Stripe Webhookは `/api/billing/webhook`。`express.raw` と署名検証を維持し、先行するJSON変換で署名検証を壊さない。
- 予備カード再決済にはイベント単位の冪等性キーがあるが、全課金処理の重複防止が検証済みとはみなさない。

## 既存の業務ルール

- トライアルは表示30日、内部 `trialEndsAt` は33日。表示には `trialDisplayEndsAt` を使う。課金予測の既契約者はStripeの実際のbilling_cycle_anchorを使う実装があるため、用途を区別する。
- トライアル投稿上限は60通。継続スケジュールは投稿成功時、ワンショット予約は作成時に加算する既存設計で、二重加算しない。
- SNSトークンは `json/client_tokens.json`。顧客削除はアプリの解約経由とし、microCMSから直接削除しない。孤児トークン検知は通知のみで自動削除しない。
- 解約時に最終請求の決済を試み、カードdetachは解約から23時間30分経過後のジョブで行う。同一メールの再登録は24時間ロックし、既存の検証アカウント例外を尊重する。
- 顧客向けメールは `customerMailer.js` の共通署名を使用。テンプレートに署名を重複追加しない。運用障害通知は別経路。
- 管理画面・管理APIは存在する。旧CLAUDE.mdの「管理GUIは存在しない」は古い記述。
- 既存資料では公開済みInstagram投稿のAPI削除を提供しない運用。削除可能と約束したり、確認のために実投稿したりしない。

## 定期実行

ホストはJST、cronサービスは調査時active。以下は登録内容の確認であり、各ジョブの成功確認ではない。

| 処理 | 登録時刻・間隔 |
|---|---|
| 予約生成 / 予約実行 | 各10分ごと |
| 再試行 | 3分ごと |
| 承認期限確認 | 20分ごと |
| Xトークン更新 | 15分ごと、root crontabに毎日03:10も存在 |
| Instagram / Threadsトークン更新 | root crontabで毎日03:00 / 03:05 |
| 自動停止同期 / 日次管理集計 | 毎日04:00 |
| X追加料金変更の適用 | 毎日04:20 |
| 孤児トークン確認 | 毎日05:00 |
| トライアル通知 | 毎日09:00 |
| トライアル上限後の自動課金開始確認 | 毎時15分 |
| 解約後カード削除 | 毎時45分 |
| 月次管理集計 | 毎月1日00:10 |

- 主な登録先は `/etc/cron.d/edgeailab-net-*` とroot crontab。X更新の重複登録の意図は未確認。
- X追加料金変更サービスは `--apply` 付きで、本番Stripeの価格変更を行い得る。調査や動作確認のために実行しない。
- `/etc/cron.d/sns-scheduler` は別プロジェクトの停止済み登録。混同しない。
- 課金開始ジョブのコメントに、過去の重複契約・課金と是正の記録がある。スキーマ更新失敗とStripe更新の関係を慎重に扱う。現在の再発を確認したものではない。

## 検証範囲

移行調査はユーザー提供のVPS出力に基づく。稼働イメージとソースの一致、全ジョブの正常終了、外部審査画面、全画面説明、障害回復経路は未検証。

`npm test` は `node --test src`。本番ディレクトリで無条件に実行せず、外部API・本番データ・ファイル書き込みへの依存を調べ、安全な隔離環境で変更に必要な検証を行う。調査時に発見した確認事項の修正は、依頼された範囲で別途行う。
