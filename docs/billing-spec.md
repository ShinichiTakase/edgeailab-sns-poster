# 請求まわり仕様（実装からのリバースエンジニアリング）

実際のコード（`src/routes/billing.js`・`src/routes/account.js`・`src/routes/auth.js`・
`src/lib/customerStore.js`・`src/middleware/requireAuth.js`・`src/lib/invoiceTax.js`・
`src/lib/invoiceSummary.js`・`src/lib/meterEvents.js` 等）を突き合わせて起こした仕様書。

- **外部仕様**: 顧客・サポート対応者から見た「何が起こるか」（画面表示・課金タイミング・金額）。
  実装の詳細を知らなくても読める記述にしている。
- **内部仕様**: それを実現しているコード上の仕組み（API呼び出し・判定ロジック・データ構造）。
  file:line 参照つき。改修時はこちらを読む。

コードコメントに明記されている事実と、コード構造から論理的に導かれる推定事項は区別し、
推定事項には「※要検証」を付す。

---

# 第1部: 外部仕様

## 0. 課金の基本構造（顧客向け説明ベース）

1つのサブスクリプションに、以下3つの料金要素が含まれる（プランはBasic/Standard/Advancedの3種）。

- **①基本料金**: 定額、毎月前払い
- **②従量料金**: 全SNS合計の投稿数に応じた段階制課金。**前月分をその翌月にまとめて後払い**
- **③Xサーチャージ**: X（旧Twitter）への投稿にのみ追加でかかる段階制課金。②と同様に**前月分を翌月後払い**

トライアル期間は表向き**30日間**。

## 1. トライアル期間中の解約

- 支払い方法（クレジットカード）を**まだ登録していない**状態で解約した場合、Stripe側には何の課金も
  発生していないため、そのまま解約が完了する。
- 支払い方法を**既に登録済み**（トライアル終了後の課金開始日を予約済み）の状態で解約した場合も、
  トライアル中はまだ課金が始まっていないため、解約時点で即座にキャンセルされ、**最終請求は発生しない**。
- どちらの場合も、未実行の予約投稿はすべて削除され、アカウントは「解約済み」表示になり、
  ログインセッションはすべて無効化される。

## 2. トライアル期間終了後の支払い方法未登録

- トライアル期間（表向き30日）が過ぎても支払い方法を登録していない顧客は、アプリの機能利用が
  ブロックされ、支払い方法登録画面へ案内される。
- **この時点ではアカウントは「解約」扱いにはならず、Stripe側の課金も一切発生しない。**
  支払い方法を登録（決済登録完了）した時点で初めて課金サイクルが始まる。
- これとは別に、トライアル中は全SNS合計で**60通**という投稿数の上限があり、期間内でもこれに達すると
  投稿がブロックされる（時間経過とは別軸の制限）。

## 3. トライアル期間終了後の初回請求

- トライアル終了直後の**初回請求は基本料金のみ**。従量料金・Xサーチャージは0円になる。
  （従量課金は「前月分を後払い」する仕組みのため、トライアル明け直後はまだ集計対象の実績期間がない）
- トライアル終了間際（残り2日未満）に駆け込みで支払い方法を登録した場合は、上記の「トライアル終了と
  同時に課金開始」というルールを設定できず、**即時課金にフォールバック**する。この場合、
  本来の課金開始日より最大で数日分早く課金される可能性がある（既知の許容誤差）。

## 4. トライアル期間終了後の２回目以降の請求

- 2回目以降は毎月、以下の内訳で自動請求される。
  - 基本料金（当月分、前払い）
  - 従量料金（**前月分**、後払い、段階制の単価が投稿数に応じて適用される）
  - Xサーチャージ（**前月分**、後払い、X投稿数のみが対象）
- 請求情報画面・領収書PDFのプラットフォーム別内訳（X/Threads/Facebook等ごとの投稿数・金額）は、
  実際の投稿記録の件数比率で請求額を按分して表示する参考値であり、Stripe側の合計金額（実際の
  課金額）とは常に一致するように作られている。

## 5. トライアル期間中のプラン変更

- Basic → Standard → Advanced の順にのみアップグレードでき、**ダウングレードは不可**。
- トライアル中（まだ課金が始まっていない状態）のプラン変更は、次回の課金開始時に反映される予約に
  過ぎず、**この時点での課金は一切発生しない**。

## 6. 本稼働後のプラン変更

- アップグレードのみ可能（ダウングレード不可、トライアル中と同じ制約）。
- プラン変更は**即座に反映**されるが、**日割り計算は行わない**。変更時点での追加請求・返金は発生せず、
  次回の通常の請求タイミングで、その時点の新プラン料金がそのまま請求される。
- ※要検証: 前述の「従量料金は前月分を翌月後払い」する仕組み上、**プラン変更をまたいだ請求期間の
  投稿数**については、変更前後で単価を分けず、期間末の請求時点で有効な**新プランの単価が
  期間全体（変更前の投稿分も含む）に適用される可能性がある**。顧客への案内文言を作る際は、
  この点をStripe側で実機確認してから確定させることを推奨する。

## 7. 本稼働後の解約と最終請求

- 解約すると、サブスクリプションは**即座に**キャンセルされる（期間終了を待たない）。
- 登録済みのクレジットカード情報はすべて自動的に削除される（FAQ「解約した場合は自動的にカード情報は
  削除されます」の通り）。
- ※要検証: 「従量料金は前月分を翌月後払い」する仕組み上、**解約時点でまだ確定していない当月分の
  従量利用（投稿数）が最終請求として計上されるのか、それとも切り捨てられるのか**は、実装からは
  断定できない（他の挙動と異なり、この点について実機検証済みという記録が見当たらない）。
  経理・サポート対応上重要になり得るため、Stripe側での実機確認を推奨する。

## 8. 消費税計算方法（Stripeの金額と請求情報が完全一致するかどうか）

- 画面・領収書PDFに表示される税額・合計金額は、**常にStripe側が実際に計算・確定した金額をそのまま
  表示**する設計になっている。そのため、**Stripeの金額と請求情報表示は原理的に必ず完全一致する**
  （アプリ側で別途税額を計算し直して表示することはない）。
- 税率は10%。丸め方式は「明細行ごとに個別計算して合算」ではなく、「税別合計に対して1回だけ税率を
  掛けて四捨五入（0.5は切り上げ）」という方式で、Stripeの実際の計算結果と実機で一致することを
  確認済み（コード内コメントに記載）。
- ※要確認: Stripe側の自動税計算機能が正しく有効化されているかどうかは、このアプリのコード内では
  確認できない（Stripe管理画面側の設定に依存していると推測される）。万一その設定が無効化されると、
  税額表示が0円になってしまう可能性があるため、定期的にStripe管理画面側の設定状態を確認することを
  推奨する。

## その他、顧客対応上の特記事項

- クレジットカードは**最大2枚**まで登録可能（プライマリ／バックアップ）。プライマリカードでの決済が
  失敗した場合、バックアップカードが登録されていれば**即座に**自動で再決済を試みる
  （Stripe標準の督促機能とは別に用意した独自の仕組み）。バックアップでも失敗した場合は通常の
  Stripeの督促プロセスに委ねられる。
- 有効なサブスクリプションがある間は、登録カードを0枚にすることはできない（最後の1枚は削除不可）。
  解約済みアカウントであればこの制限はない。
- トライアル終了が近づくと（表向きの残り3日以内）、1顧客につき1回だけリマインドメールが送られる
  （日次バッチ）。

---

# 第2部: 内部仕様（実装の仕組み）

## 0. 課金アーキテクチャ

- Stripe Checkout（`mode: subscription`）で、1サブスクリプションに3つのPrice（Price ID）を持たせる構成。
  - ①基本料金（`base`）: 定額、月次前払い
  - ②従量料金（`metered`）: 全SNSプラットフォーム合算の投稿数に対する**段階制（graduated tiers）**課金
  - ③Xサーチャージ（`meteredX`）: X投稿のみに追加でかかる段階制課金
  - プラン（Basic/Standard/Advanced）ごとに①②③のPrice IDが分かれている
    （[stripePricing.js](../src/lib/stripePricing.js)）。
- 従量課金はStripe Billing Meterのイベント送信（`stripe.billing.meterEvents.create`）で計上される
  （[meterEvents.js](../src/lib/meterEvents.js)）。投稿が成功するたびに`post_created`イベントを送信し、
  投稿先がXの場合は追加で`x_surcharge_post`イベントも送信する
  （[scheduledPostExecutor.js:109-111](../src/lib/scheduledPostExecutor.js)、
  [posts.js:209-211](../src/routes/posts.js)）。
  - Meterのcustomer_mappingは`by_id`（`stripe_customer_id`）であり、特定のサブスクリプションitem/Priceには
    紐付いていない。プラン変更で従量Priceが切り替わっても、Meter自体は同一顧客に紐付いたままである点は
    「6. 本稼働後のプラン変更」の特記事項に関わる。
- 段階制Priceの実額計算はStripe側のtiers定義を唯一の情報源とし、アプリ側にハードコードしない
  （[stripeTierPricing.js](../src/lib/stripeTierPricing.js)の`computeGraduatedAmount`は、Stripeから取得した
  tiersを使って請求予測を行うための検算ユーティリティ）。

## 1. トライアル期間中の解約

- トライアル日数は表向き**30日**（`TRIAL_DAYS`）だが、DB上の`customers.trialEndsAt`には
  内部バッファ**3日**を加えた**33日後**の日時が入る（`TRIAL_INTERNAL_BUFFER_DAYS`、
  [auth.js:17-33](../src/routes/auth.js)）。理由はStripe Checkoutの`subscription_data.trial_end`が
  「現在時刻より2日超先」を要求する制約に抵触しないための安全マージン（実測確認済みとコメントにあり）。
  画面の「残り◯日」表示にはバッファを差し引いた`trialDisplayEndsAt`を使う。
- トライアル中に**まだ支払い方法（Stripe Checkout）を登録していない**場合、
  `customer.stripeSubscriptionId`は存在しない。この状態で解約すると
  （`POST /api/account/cancel`、[account.js](../src/routes/account.js)）:
  1. `stripeSubscriptionId`が無いため`stripe.subscriptions.cancel()`はスキップされる。
  2. `stripeCustomerId`があればカード情報の削除処理を試みるが、そもそも未登録なら0件で完了。
  3. 未実行（pending）の予約投稿をすべて削除する。
  4. `customers.status`を`canceled`に変更し、全メンバーの`sessionVersion`をインクリメントして
     既存セッションを無効化、Cookieをクリアする。
- トライアル中に**既に支払い方法を登録済み**（Checkout完了済みで`trial_end`付きのStripeサブスクリプションが
  `trialing`ステータスで存在する）場合、解約すると`stripe.subscriptions.cancel()`が呼ばれ、
  トライアル中のサブスクリプションが**即時キャンセル**される。
- Stripe側APIエラー時（`stripe.subscriptions.cancel`が失敗、またはSTRIPE_SECRET_KEY未設定）でも、
  **顧客側の解約処理自体は止めない**という設計方針。運用宛て通知メール（`notifyFailure`）を送り、
  Stripe管理画面での手動対応に委ねる。`customers.status`は`canceled`に更新されるため、
  顧客からは正常に解約済みに見える一方、Stripeのサブスクリプションだけが残存し得る
  （運用アラートで拾う設計）。

## 2. トライアル期間終了後の支払い方法未登録

- アクセス制御の判定本体は`customerStore.requiresPaymentRegistration()`
  （[customerStore.js:478-485](../src/lib/customerStore.js)）:
  - `stripeSubscriptionId`があれば常に`false`（決済済み）。
  - `status === "canceled"`なら`false`（専用の`blockCanceledCustomer`ガードに委ねるため対象外）。
  - `status !== "trial"`（＝解約後の同一メール再登録で`reactivateCustomer`が付与する`"active"`状態、
    後述）なら常に`true`（猶予なし・即支払い必須）。
  - `status === "trial"`かつ`trialEndsAt`（内部バッファ込み33日基準）を経過していれば`true`。
- `true`の場合、`blockExpiredTrial`ミドルウェア（[requireAuth.js:78-85](../src/middleware/requireAuth.js)）が
  `/upgrade.html?reason=trial_expired`（トライアル経由）または`?reason=payment_required`
  （トライアルを経ない解約後再登録）へリダイレクトし、アプリの機能利用をブロックする。
  アカウント自体は`canceled`にはならず、Stripe側の課金も一切発生しない（サブスクリプションが
  まだ存在しないため）。
- トライアル中の投稿数上限（全SNS合計60通、`TRIAL_POST_LIMIT`）に達した場合の
  `requireUnderTrialPostLimit`は、この支払い未登録ブロックとは**別軸のガード**であり、
  時間経過ではなく投稿数で制限する（[customerStore.js:487-501](../src/lib/customerStore.js)）。

### 補足: 解約→同一メール再登録時の扱い
- `reactivateCustomer`（[customerStore.js:395-428](../src/lib/customerStore.js)）は、解約済み
  （`status: canceled`）の顧客が同一メールで再サインアップした際、新規レコードを作らず既存レコードを
  再利用する。**トライアルは再付与しない**（2026-08-22修正。以前はここでトライアルを再付与してしまい、
  「解約→再登録で無料トライアルを再取得できる抜け穴を塞ぐ」という導入時の意図に反していたバグがあった）。
- `customers.status`のselect選択肢は`trial`/`active`/`canceled`の3つしかなく、
  「トライアルなし・未払い」専用の値を追加できないため、既存の`"active"`を流用している
  （`trialEndsAt`は空）。この場合`requiresPaymentRegistration`は`status !== "trial"`分岐に入り、
  猶予なしで即支払い必須となる。

## 3. トライアル期間終了後の初回請求

- Stripe Checkout時に`trial_end`をStripeの`trial_end`（Unixタイムスタンプ）としてそのまま設定する
  （[billing.js:51-72](../src/routes/billing.js)）。これによりStripeの仕様上
  `billing_cycle_anchor`が自動的に`trial_end`と同日に設定される（実機検証済みとコメントにあり）。
  月末日のズレ（例: アンカーが1/31→2月は2/28（うるう年は2/29）、3月は3/31）もStripe側が自動吸収する。
- `trial_end`は現在時刻より2日超先である必要がある（Stripe Checkout Session経由の制約、実測確認済み）。
  既にトライアル終了間際（2日未満）・終了済みの顧客が今から決済登録する場合は`trial_end`を設定せず、
  即時課金にフォールバックする（`MIN_TRIAL_END_LEAD_SECONDS = 2日+5分`のマージン）。
- 本稼働開始日（＝トライアル終了日の翌日、内部バッファ込みの`trialEndsAt`基準）を含む月の
  初回請求は基本料金のみ。従量料金・Xサーチャージは0円（[billing.js:718-723](../src/routes/billing.js)
  の`predictFromScheduledPosts`より）。これは、従量課金が「前期間分を後払い」する構造のため、
  トライアル期間中は集計対象の「前期間」が存在しない（＝Stripe側で計上されるMeterイベントの実績期間が
  ゼロ）ことに起因する。

## 4. トライアル期間終了後の２回目以降の請求

- 請求予測API（`GET /api/billing/upcoming`）では、実際のサブスクリプションがカバーする期間内なら
  Stripeの`invoices.createPreview`（Stripe側が段階制課金込みで計算済みの実額に近い値）を優先して使う
  （`tryUpcomingInvoiceAmounts`）。それ以外（サイクル外の月）は、`scheduled_posts`（単発予約投稿）と
  スケジュール投稿の生成予定件数を合算し、Stripeの実際のPrice tiersに当てはめて予測する
  （`predictFromScheduledPosts`）。単価・閾値はアプリ側にハードコードせず、都度Stripeから取得する設計。
- 実際の確定済みinvoiceの内訳表示（請求情報一覧・PDF領収書）は`buildInvoiceSummary`
  （[invoiceSummary.js](../src/lib/invoiceSummary.js)）が担う。Stripeの従量課金は全プラットフォーム
  合算の単一カウンターであり、プラットフォームごとの実単価は段階制のため存在しない。表示上は
  「実際の投稿記録（`posting_logs`）の件数比率で、Stripeの実請求額（`usageTotalAmount`）を按分した
  平均単価」を使い、最終行で端数を吸収して合計が必ずStripeの実額と一致するようにしている
  （[invoiceSummary.js:54-95](../src/lib/invoiceSummary.js)）。あくまで表示上の按分であり、
  実際の課金ロジック（段階制tiers）とは別物である点に注意。

## 5. トライアル期間中のプラン変更

- `POST /api/billing/change-plan`は**アップグレードのみ許可**（`Basic → Standard → Advanced`の順、
  `PLAN_ORDER`。ダウングレードは常に400エラー、[billing.js:20, 97-119](../src/routes/billing.js)）。
- トライアル中で**Stripeサブスクリプションがまだ存在しない**（`stripeSubscriptionId`が空）場合、
  Stripe側の更新は一切行わず、**microCMSの`customers.plan`のみ更新**する
  （[billing.js:127-129](../src/routes/billing.js)）。実際のPrice選択は、次回Checkout完了時に
  `pricesForPlan()`が更新後のplanを参照することで自動的に反映される。

## 6. 本稼働後のプラン変更

- 既にStripeサブスクリプションが存在する場合（`stripeSubscriptionId`あり）、対象サブスクリプションを
  取得し、現在の3つのPrice ID（base/metered/meteredX）を新プランのPrice IDに`items`ごと差し替える。
- `proration_behavior: "none"`を明示的に指定しており、日割り調整は一切行わない
  （[billing.js:164-171](../src/routes/billing.js)）。変更は即時反映されるが、このリクエスト内では課金しない。
  実際の請求は次回の通常のサブスクリプション更新時に、その時点の`items`（＝新プラン）の金額で行われる。
- Stripe側の更新が成功した後にmicroCMSの`customers.plan`を更新する順序。ここでmicroCMS側の更新が
  失敗しても**Stripe側の変更は取り消さない**（`ok:false, error:"reflection_delayed"`を返すのみ。
  [billing.js:181-197](../src/routes/billing.js)）。

### ※要検証（コード上は未検証だが構造上示唆される特記事項）
- Stripe Billing Meterのcustomer_mappingは`by_id`（顧客単位）であり、サブスクリプションのitem/Priceには
  紐付いていない（[meterEvents.js](../src/lib/meterEvents.js)冒頭コメント参照）。一方
  `proration_behavior: "none"`で行われるプラン変更は、当該請求期間の残り期間の従量課金itemを
  旧Priceのまま維持する（分割計上する）のではなく、単純にitemを新Priceへ差し替えるだけに見える。
  そのため、プラン変更前後の従量投稿数（Meterイベント）が区別されず、その請求期間中の投稿数
  合計が、期間末の請求時点で有効な新プランの段階制tiers単価で一括計算される可能性がある
  （＝変更前の投稿分も新プランの単価が適用される）。これはStripeのMetered Billing＋Graduated Tiers＋
  Subscription item差し替えの一般的挙動から論理的に導かれる推定であり、コード内に明示的な検証・
  対処（例: 変更時点で従量分を締めて確定させる等）は見当たらない。

## 7. 本稼働後の解約と最終請求

- `POST /api/account/cancel`は`stripe.subscriptions.cancel(customer.stripeSubscriptionId)`を
  **オプションなしで**呼び出す（[account.js:51](../src/routes/account.js)）。これはStripeサブスクリプションの
  即時キャンセル（期間終了を待たない）であり、`invoice_now`や`prorate`等のオプションは一切渡していない。
- 解約成功後、登録済みの全カード（PaymentMethod）をStripe Customerからdetachする
  （FAQ「解約した場合は自動的にカード情報は削除されます」の実体、[account.js:92-125](../src/routes/account.js)）。
- Stripe側のキャンセル・カードdetachが失敗しても、顧客側の解約処理自体は止めない方針は
  トライアル中の解約と同様（運用宛てメール通知＋Stripe管理画面での手動対応に委ねる）。
- 未実行の予約投稿を全削除し、`customers.status`を`canceled`に、全セッションを無効化する
  （トライアル中の解約と共通処理）。

### ※要検証（最終請求に関する特記事項）
- 前述の通り、従量料金・Xサーチャージは「前月分をその翌月の請求で後払い」する構造になっている
  （[billing.js](../src/routes/billing.js)の`predictFromScheduledPosts`コメントより）。
  `stripe.subscriptions.cancel()`をオプションなしで即時実行した場合、まだ確定（invoice化）されていない
  「解約時点までの当月分の従量利用」が、最終請求として計上されるかどうかはコード上明示的に制御されていない
  （`invoice_now: true`等を渡していないため、Stripe側のデフォルト挙動に委ねられている）。
  他の箇所（消費税の丸め方式等）では実機での挙動確認がコメントに明記されているのに対し、
  この解約時の最終請求についてはそうした検証コメントが見当たらないため、「解約月の未確定の従量利用分が
  最終的に請求されるか、されないまま切り捨てられるか」は実装からは断定できない。

## 8. 消費税計算方法（Stripeの金額と請求情報が完全一致するかどうか）

- 消費税率は`config/tax.json`（`consumption_tax.rate: 0.10`）を単一情報源とする
  ([invoiceTax.js](../src/lib/invoiceTax.js))。
- 実際に画面・PDF領収書に表示する税額・合計額は、Stripe側の確定値（`invoice.tax`・`invoice.total`）を
  そのまま使う（[invoiceSummary.js:114-119](../src/lib/invoiceSummary.js)）。アプリ側の
  `computeConsumptionTax()`はあくまで「Stripeの`automatic_tax`が有効な場合にこの値と一致するかどうかの
  検算・将来の見積り機能用」の位置づけであり、実際の請求額算出には使われていない。
  → 設計方針として、Stripeの金額と請求情報表示は常に完全一致する（Stripeの値をそのまま転記するため、
  ズレが原理的に発生し得ない）。
- 丸め方式はコード内コメントに実機突き合わせ済みと明記されている:
  「税別合計に対して**1回だけ**税率を掛けて`Math.round`（0.5は切り上げ）する」方式であり、
  明細行ごとに個別計算して合算する方式ではない。Stripe側は表示用に行ごとにも税額を按分するが、
  それは内部的な按分表示に過ぎず、`invoice.tax`自体は常に「合計への一括丸め」と一致することを実機で
  確認済みとのこと（例: 5円＋5円の2行 → 各行の按分は1円/0円と不均等だが、
  `invoice.tax`は`round(10 × 0.10) = 1円`に一致した、というテストケースがコメントに記載されている）。
- ※要確認: `automatic_tax: { enabled: true }`のような設定は、`stripe.checkout.sessions.create()`を
  含むアプリのコード内には見当たらない。つまりStripeの自動税計算（Stripe Tax）は、このリポジトリの
  コードではなくStripe管理画面側の設定（Tax設定・Price/Productのtax_behavior等）に依存していると
  推測される。automatic_taxが無効化される・設定が外れるとinvoice.taxが0円になり得るため
  （invoiceSummary.jsのコメントにも「automatic_tax未有効時は0円」との記載あり）、
  税額表示が正しく機能しているかはStripe管理画面側の設定状態に依存する外部要因である点に留意。

## その他の実装上の特記事項

- **Xサーチャージの二重管理**: `config/surcharge.json`（¥32/post、表示用）とStripe側の実Price tiers
  は別々に保持されており、Stripe側でPriceを変更した際は`config/surcharge.json`の数値も手動で
  同期する運用（[surchargeConfig.js](../src/lib/surchargeConfig.js)コメントより）。自動同期の仕組みはない。
- **カード（お支払い方法）は最大2枚**まで登録可能で、primary/backupの優先度をPaymentMethodの
  `metadata.priority`で管理する。プライマリカードの決済失敗時（`invoice.payment_failed`Webhook）、
  バックアップカードが登録されていれば即座に再決済を試みる独自実装
  （Stripeのデフォルト挙動は同一カードへのSmart Retryのみで、別カードへの自動切替は行わないため、
  [billing.js:463-555](../src/routes/billing.js)）。バックアップでの決済も失敗した場合は、
  通常のStripe自動督促（dunning）に委ねて追加処理はしない。
- **Webhookの冪等性**: Webhook再送（redelivery）対策として、`event.id`をinvoiceの`metadata`に
  書き込んでから通知メールを送る順序にし、二重送信を防いでいる（メール未送信で処理が落ちる可能性は
  許容し、二重送信の防止を優先する設計判断がコメントに明記されている）。
- **カード削除の制限**: 有効なサブスクリプションがある間は、登録カードが最後の1枚になる削除操作は
  拒否される（409）。解約済みなら制限されない。
- **トライアル終了リマインドメール**: トライアル残り3日以内（`REMINDER_WINDOW_DAYS`、
  表向きの残日数ベース）になったタイミングで1顧客につき1回だけ送信する日次cron
  （[trialReminderCheck.js](../src/scripts/trialReminderCheck.js)）。内部バッファ3日と
  `REMINDER_WINDOW_DAYS=3`はたまたま同じ日数なだけで意図的に連動しているわけではない、と
  コード内コメントに明記されている（どちらかを変更する際は要見直し）。
- **請求予測はあくまで近似値**: `GET /api/billing/upcoming`はサイクル外の月について、Stripeの実際の
  `billing_cycle_anchor`（日単位・月末日ズレ調整込み）までは再現せず、「本稼働開始日が属する月」を
  基準にした月単位（カレンダー月）の近似として計算している（[billing.js:666-673](../src/routes/billing.js)
  のコメントより、意図的な設計上の簡略化）。
