# 内部仕様: FAQ

最終更新日: 2026-08-24（更新: グローバルメニューのハンバーガー化を反映）
コード参照: edgeailab.net/faq.html, edgeailab.net/index.html, edgeailab.net/dashboard.html,
edgeailab.net/features.html, edgeailab.net/pricing.html,
edgeailab.net/partials/header-nav.html,
deploy/xserver-vps/proxy/edgeailab.net.conf, deploy/xserver-vps/docker-compose.yml

## 位置づけ

faq.htmlはsns-poster（アプリ本体）ではなく、静的サイトedgeailab.net配下の公開ページ
（ログイン不要）。ダッシュボード（sns-posterアプリの一部）とマーケティングサイトの
両方からリンクされる。edgeailab.netとsns-posterは別々のgitリポジトリ・別々のデプロイ
手順を持つため、対応時は両リポジトリの変更を追跡する必要がある。

## グローバルメニューの共通コンポーネント化（SSI）

index.html・features.html・pricing.html・faq.htmlの4ページでヘッダーの
`<nav class="main-nav">`部分が重複しており、FAQリンク追加時にトップページにしか
反映されず他3ページへの反映が漏れる不整合が実際に発生した。これを受けて
`partials/header-nav.html`に切り出し、nginxのSSI（Server Side Include）で
共通化した。

- nginx設定（`deploy/xserver-vps/proxy/edgeailab.net.conf`）の`server`ブロックに
  `ssi on;`を追加
- `/partials/`配下は`location /partials/ { internal; }`で直接アクセスを404にし、
  SSI include経由でのみ参照可能にする（nginx:alpineのビルドには
  `ngx_http_ssi_module`がデフォルトで組み込まれているため追加のビルド設定は不要）
- 各ページのヘッダーは`<!--#include virtual="/partials/header-nav.html" -->`で参照
- 現在地ハイライト（`.active`クラス）はページごとに`class="active"`を直接書く方式を
  やめ、`data-nav`属性と`location.pathname`をブラウザ側で比較する小さなインライン
  スクリプト（`partials/header-nav.html`末尾に同梱）で付与する方式に変更した
- `docker-compose.yml`の`edgeailab-net-static`サービスに`partials/`ディレクトリの
  bind mountを追加（既存の`css`/`js`/`images`と同じパターン）

### ハンバーガーメニュー化（2026-08-24追加）

幅1024px以下で`.main-nav`・`.header-actions`を非表示にし、代わりに`.nav-toggle`
ボタンを表示する。CSS（ブレークポイント定義含む）は4ページ（index/features/pricing/
faq）それぞれの`<style>`内に重複実装されている（SSI化されているのは
`partials/header-nav.html`のHTML/JS部分のみで、各ページ固有の`<style>`はSSIの対象外
のため。ナビ項目のCSSを変更する際は4ページ全てへの反映漏れに注意）。開閉トグルの
JS（`.site-header`への`nav-open`クラス付け外し、外側クリックで閉じる）は
`partials/header-nav.html`末尾のスクリプトに実装されており、こちらはSSI経由で
4ページ共通。

対応SNSのポップオーバー（`.nav-popover`）は、開いたまま画面外クリックしても閉じない
不具合があったため（bb01670時点）、既定で非表示・タップで`nav-popover-open`クラスを
トグルするアコーディオン形式に修正した（ec76c22）。`window.matchMedia('(max-width:
1024px)')`でモバイル判定し、デスクトップ幅では従来通りhoverポップオーバーとして
動作する。

## faq.htmlの構成

features.html/pricing.htmlと同じ`site-header`＋モーダル（プライバシーポリシー等）＋
フッターのテンプレートを踏襲した公開ページ。本文は`<details>`要素によるネイティブ
アコーディオン（`.faq-item[open] summary::after`でトグルアイコンの表示を切替。JS不要）。
全21件、`id="faq-1"`〜`id="faq-21"`で個別アンカーが可能。

## index.htmlのFAQプレビューブロック

「主要機能」セクション（`features-preview`）と「対応SNS」統計セクション
（`section-dark`）の間に`<section class="section faq-preview jp-font">`を新設。
Q1〜Q5のみを同じ`<details>`アコーディオンで表示し、末尾に既存の
`features-preview-cta`と同じ見た目（`btn btn-outline`）の「もっと見る…」ボタンで
faq.htmlへリンクする。

## ダッシュボードからの導線

`dashboard.html`のサイドバー`<a href="#">FAQ</a>`（プレースホルダー）を
`<a href="faq.html">FAQ</a>`に変更しただけ。faq.html自体はログイン不要な公開ページの
ため、ダッシュボードの認証チェックやサイドバーUIは経由せず、通常のページ遷移
（フルリロード）で表示される。

## 実装レビューで判明した既存実装との乖離（2026-08-22）

FAQ執筆時に全問（作成当初はQ1〜Q20）を実装と突き合わせた結果、以下の乖離が判明し
対応した。

| Q | 内容 | 対応 |
|---|---|---|
| Q4 | ユーザー数上限（Basic1/Standard・Advanced3）が未実装 | コード実装。`config/teamMemberLimits.json`新設、`team.js`招待APIに上限チェック追加（内部仕様_メンバーを招待する.md参照） |
| Q9 | 解約時のカード自動削除が未実装 | コード実装。`account.js`の解約処理に`stripe.paymentMethods.detach`を追加（内部仕様_解約.md参照） |
| Q6 | 「解約までの従量料金は次回請求時にご請求」という記述が、Stripeの実際の挙動（解約時点で最終請求書を即時発行）と不一致 | FAQ文言を実態に合わせて修正（コード変更なし） |
| Q12 | 「指定時刻から1時間の範囲」という固定仕様の記述が、実際の時間帯（最低30分幅）内ランダム配信という実装と不一致 | FAQ文言を修正（コード変更なし） |
| Q18 | 「1日最大3回」がアカウント全体の上限であるかのような記述だったが、実際は1スケジュールあたりの上限 | FAQ文言を修正（コード変更なし） |
| Q3 | Instagramを含む5 SNSが一般利用可能。Facebook/Instagram/ThreadsはMeta審査通過済みで、`config/snsConnectionMode.json`は`live` | 公開FAQと接続モードを正式提供状態に統一 |
| Q11 | スケジュール投稿は動画未指定時にフィード投稿へフォールバックする実装がある、との指摘があったが、スケジュール投稿に動画指定UI自体が存在しないため実質常にリールになる | 現状維持（記載は正しいと確認） |

## Instagram投稿削除不可の注記（Q21）追加の経緯

`sns-poster/CLAUDE.md`に2026-08-19付けで残っていた未対応TODO「ダッシュボードのFAQ
またはヘルプ文書に、投稿後の削除は各SNSアプリから手動で行う必要がある旨を追記する
こと」に対応した。Instagram Graph APIには公開済みメディアの削除エンドポイントが
存在しない（`DELETE /{media-id}`が`Unsupported delete request`エラーになる、実機
検証済み）ため、Q21として追加。`sns-poster/CLAUDE.md`の該当TODO注記も完了済みに
更新した。

## デプロイ

edgeailab.net側（faq.html・index.html・features.html・pricing.html・
partials/header-nav.html・dashboard.html・deploy/xserver-vps配下のnginx設定・
docker-compose.yml）はいずれも
`cd /opt/project/deploy/xserver-vps && docker compose up -d --force-recreate
edgeailab-net-static`で反映する（nginx設定・partials/もbind mountのため、同一
コマンドで反映される。イメージの再ビルドは不要）。

sns-poster側（team.js・account.js等のコード変更）は通常のsns-posterデプロイ手順
（`docker compose build sns-poster && docker compose up -d sns-poster`）に従う。

## 要確認事項

- なし
