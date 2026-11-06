# Facebook Pageリール・共通動画（2026-10-15、隔離実装／本番未反映）

## データ・実行

対象は継続スケジュールの投稿先選択、投稿文章の追加・編集・生成・予約実行。Facebook個人プロフィールは対象外。ワンショット投稿のUI/APIは今回拡張しない。
API/UIの投稿先キーは `facebook`（通常）、`facebook_reel`、`instagram`。SQLiteの既存platform制約は維持し、`schedules.facebook_reels` と `scheduled_posts.post_kind` / `posting_logs.post_kind` を追加する。通常投稿の既存行はnormal。Page選択は既存のfacebook_page_idを保存する（従来SQLite createScheduleで保存していなかった点も修正）。複数Page時、リールはPage未指定なら送信を拒否する。

共有キャプション・動画は既存の `schedule_text_variants` のinstagram行に保存する。Facebookリールのみでもこの行を使用し、Instagramアカウントへの接続は要求しない。画面は実投稿先と、共通の動画・キャプションタブを分ける。`videoGenerationJobStore`、`postCopyGenerator`、`videoGenerator`を両SNSで共有する。生成ジョブ自体は既存の一時メモリ管理であり、公開状態はSQLite管理。

予約生成キーはJSON配列 `[scheduleId, JST日付, 時間枠index, 投稿先キー]`。既存のmaterialization_key UNIQUEを使い、SQLiteトランザクション内で既存予約を返す。新しい予約から適用し、過去のNULLキーの予約を推測で移行しない。同日切替時の旧予約との重複を避けるため、配備は当日materialize終了後に行い、日付マーカーを巻き戻さない。

通常・再試行runnerは同一のSQLite claimを継続使用。claim時に前回request_started_atをクリアし、安全な再試行を可能にする。leaseは既存120秒、1/3間隔で延長。Facebook API操作前と段階保存時にも所有権を検査する。所有権を失った処理は公開を継続しない。

`external_container_id` にFacebook video_idを保存し、upload_stage、publish_started_at、publish_confirmed_atを追加。段階はstart_requested→created→upload_requested→uploaded→publish_requested→published。公開確認後のカバー結果はpublished_cover_set / published_cover_unconfirmed。

start応答喪失・ID保存失敗はambiguous。ID保存済み・公開前の失敗は同じIDで状態照会して継続する。転送が不明なら無条件に転送し直さず、状態確認を上限まで行う。公開前にpublish_requestedを永続化し、公開要求後の不明結果はambiguousで自動再送を停止する。プロセス停止でleaseが切れた場合もrequest_started_atがあればambiguous。手動照合はvideo_idの状態を確認して行い、無条件でpendingへ戻さない。

APIのfinish成功だけでは公開成功としない。publishing_phase.status=completeまで確認する。HTTPは30秒、照会は2秒間隔・最大60回。安全な失敗だけ既存の3分後再試行へ回し、4試行目で停止。権限・レート制限を含め、公開後のAPIエラーを「安全な失敗」に変更しない。独自予約キーは外部APIの冪等性を保証しない。

markSent後にログ・副作用保存が失敗してもsentを保持し、SNS送信へ戻さない。副作用の欠落は既存effect ledgerで照合・回復する別作業であり、再投稿して回復しない。通常・リール・Instagramの予約ID、効果台帳、メーターキーは独立。Facebook通常とリールの集計表示はFacebook合計、投稿ログはリールを識別する。動画生成は投稿数に加算しない。

## 共通描画

1080×1920、30fps、H.264/yuv420p、AAC 128kbps、MP4。BGM6種・背景画像・3アニメーションを共用。本文は60px・行間84px。表示領域はx=120..900、y=640..1400。タイトルはy=250..590、案内帯はy=1430..1550。文字は白、帯は#111827、計算コントラスト17.74。画面端を避ける設計だが、Metaの全端末UIやクロップを保証しない。

タイトル・「詳細はプロフィールのリンクから」は先頭から末尾まで残す。本文は黙って切り捨てない。エンドロールは折り返し後の行数と移動距離から50px/秒以下、文字数から8文字/秒以下で時間を確保し、最後の行を領域内に止めて4秒保持。typewriterも全文後4秒停止、slideinは文字量に応じた表示時間と末尾4秒を確保。長文はendrollを選び、60秒を超える本文は生成・保存前にエラー。60秒は取得できた公式サンプルの保守的な共通上限で、最新API最大値を断定するものではない。

空入力、2200文字超、最大尺超、未対応絵文字は明示的エラー。人が入力した文章は、絵文字を黙って削除せず、除去・短文化して再生成するよう案内する。ただし、AIがURL等から自動生成したキャプションは、動画生成の直前に絵文字を機械的に取り除いて使う（`stripEmojiFromCaption`、`videoGenerationJobStore.js`。2026-11-06、AIが絵文字を混ぜて全スロットが `reel_emoji_unsupported` で失敗した本番事象への対応）。先頭フレームJPEGを `.cover.jpg` として保存。Instagramはthumb_offset=0。Facebookは公開確認後に `/{video-id}/thumbnails` へsourceファイル・is_preferred=trueを送信。カバー設定失敗で再投稿しない。既存動画にJPEGがない場合は指定を省略する。カバーAPI受付・実表示は実アカウント未検証。

## Meta確認記録（2026-10-15）

- https://developers.facebook.com/docs/video-api/guides/reels-publishing/ — 429で本文取得不可。
- https://github.com/fbsamples/reels_publishing_apis/blob/main/fb_reels_publishing_api_sample/README.md — 公式サンプル。9:16、540×960以上、23fps以上、4〜60秒、推奨H.264/AAC/1080×1920。サイズ上限はn/a。
- https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api?entity=request-23987686-a9ea20fe-d410-4804-8bbe-5cc5985e9443 — Meta公式コレクション。Page token、video_reels start、rupload file_url、status照会、finish/PUBLISHEDのフローを確認。サンプルに旧versionがあるため最新版の保証とは扱わない。
- https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/page.py — 公式SDKのvideo_reelsとPage tasks定義。
- https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/advideo.py — thumbnailsのsource/is_preferred定義。
- https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/main/facebook_business/adobjects/iguser.py — cover_url/thumb_offset定義。

既存OAuth・通常投稿に合わせv26.0を使用。Facebook OAuthはscope文字列ではなくFACEBOOK_CONFIG_IDを指定しており、実権限・Pageタスク・App Review状態はソースから確認できない。設定・scopeは変更しない。pages_manage_posts等の権限、CREATE_CONTENT相当のPageタスク、Advanced Access/App Reviewの適用状態は管理画面で確認が必要。今回取得できなかった公式ガイドの最新要件、v26.0の実受付、レート上限、サイズ上限、実アカウントの承認状態は未確認。Instagram Loginの既存権限は変更しない。

## 配備・ロールバック（未実施）

006は追加カラムのみ。自動migrationは行わず、runtimeは006以上を要求する。配備前に対象DBの整合したバックアップ、旧API/各batchイメージ・静的HTMLを保管する。対象APIと関連batchの書込みを止めた管理時間帯に006を適用し、API、materializer、通常runner、retry runnerを同一ソースから配備する。新schema要求を共有する他のbatchもバージョン整合を確認する。中央Compose全体のup/downや共有proxy再起動はしない。

HTMLはschedule-form.html・schedule-detail.htmlを対象に個別反映し、ファイルbind mountとHTTP応答の一致を確認する。既存のハッシュ付きJS/CSS参照は変更しない。

切戻しはまず対象処理を止める。新リールデータがない場合のみ006.downを使用可能（隔離DBで検証済み）。リール履歴がある場合downはCHECKで拒否し、データを削除しない。旧runnerはpost_kindを知らず通常投稿に誤送信し得るため、リール予約を残したまま旧runnerを再開してはいけない。履歴を保持した前進修正、またはバックアップ時点以後の外部投稿・課金を照合した計画的復元を選ぶ。公開済み投稿はDB復元では消えない。
