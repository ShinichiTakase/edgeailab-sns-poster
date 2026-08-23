# メールアドレス認証 仕様書

対象: sns-poster（EdgeAI Lab）バックエンド + フロントエンド静的ページ（`edgeailab.net`）

最終調査日: 2026-08-23

---

## 概要

新規サインアップ時に、入力されたメールアドレスが本人のものであることを確認する機能。
「6桁コード入力」方式ではなく、**メール本文中のワンタイムリンク（トークン）をクリックする方式**を採用している。

同一パターン（ランダムトークン発行 → DB保存 → メールリンク送付 → 検証 → 使用後クリア）は、
パスワードリセット・メンバー招待・投稿承認依頼でも共通して使われている（[7. 類似機能との関係](#7-類似機能との関係) 参照）。

---

## 1. 内部仕様

### 1.1 データストア

顧客データは自前DBではなく **microCMS**（`customers` エンドポイント）に保存。ラッパーは `src/lib/microcms.js` / `src/lib/customerStore.js`。

認証情報はスキーマ数節約のため `users[]` 繰り返しフィールドにネストされている。

| フィールド | 型 | 用途 |
|---|---|---|
| `isVerified` | boolean | メール認証済みフラグ |
| `verificationToken` | string | 確認用トークン（64桁hex、未使用時は空文字） |
| `verifyExpiresAt` | string(ISO日時) | トークン有効期限 |
| `users[].email` / `users[].passwordHash` | string | ログイン認証情報（bcrypt, `BCRYPT_ROUNDS=12`） |

> トークンは**平文でDB保存**（ハッシュ化なし）。ワンタイム利用で認証成功時に空文字クリアするため、実害は限定的だが、DBダンプ流出時にはリスクとなる点は留意。

### 1.2 トークン発行〜メール送信（サインアップ時）

`POST /api/auth/signup`（`src/routes/auth.js:100-169`）

1. 入力バリデーション
   - メール形式チェック（`isValidEmail`, `auth.js:42-44`）
   - パスワード強度: 8文字以上＋大文字・小文字・数字・記号を全て含む（`auth.js:47-55`）
   - 担当者名: 3文字以上必須
2. 既存メールの重複チェック（`customerStore.getCustomerByEmail`）
   - 既存かつ未解約 → `409 email_exists`
   - 既存かつ解約済み（`status === "canceled"`）→ `reactivateCustomer`で再利用（旧usersを破棄し本人のみに置換、トライアル再付与なし）
   - 新規 → `createCustomer`
3. トークン生成: `crypto.randomBytes(32).toString("hex")`（256bit・64桁16進、暗号学的安全な乱数）
4. 有効期限: `VERIFICATION_TOKEN_TTL_MS = 24時間`（`auth.js:16`）
5. `customers` レコードに `verificationToken` / `verifyExpiresAt` を保存
6. `sendCustomerMail()` で `VERIFICATION_EMAIL` テンプレート送信（`src/lib/emailTemplates.js:10-23`）
   - **送信失敗してもサインアップ自体は失敗させず**、警告ログのみ出力（`auth.js:154-156`）
7. **認証未完了のままセッションCookie（JWT）を発行し即ログイン状態にする**（ダッシュボードは見せるが機能は`isVerified`で別途制限）
8. レスポンス: `{ ok: true, requiresPayment: Boolean(existing) }`

### 1.3 確認メール本文テンプレート

`src/lib/emailTemplates.js:10-23`（`VERIFICATION_EMAIL`）

```
件名: 【EdgeAI Lab】メールアドレスの確認をお願いします

この度はEdgeAI Lab（sns-poster）にお申し込みいただきありがとうございます。
選択プラン: {Basic|Standard|Advanced}

以下のリンクをクリックして、メールアドレスの確認を完了してください。
{APP_BASE_URL}/api/auth/verify?token={64桁16進トークン}

このリンクの有効期限は24時間です。
心当たりがない場合は、本メールを破棄してください。
```

### 1.4 リンク検証処理

`GET /api/auth/verify?token=...`（`src/routes/auth.js:171-200`）

処理順序:
1. `token`クエリなし → `verify-pending.html?error=missing_token` へリダイレクト
2. `customerStore.getCustomerByVerificationToken(token)` でmicroCMSを `filters=verificationToken[equals]...` 検索
   - 該当なし → `?error=invalid_token`
3. `verifyExpiresAt` が現在時刻より過去 → `?error=expired_token`
4. 成功時:
   - `customerStore.markVerified(id)`（`customerStore.js:141-147`）: `isVerified: true` に更新、`verificationToken`/`verifyExpiresAt`を空文字にクリア（**トークンは1回使い切り**、再利用不可）
   - 最新顧客情報を再取得しJWTセッションを再発行（`signSession`）→ Cookie更新
   - `dashboard.html` へリダイレクト
5. 例外発生時 → `?error=internal_error`

### 1.5 再送信

`POST /api/auth/resend-verification`（`src/routes/auth.js:202-245`）

- レート制限: メールアドレスをキーにしたプロセス内メモリの`Map`（`lastResendAt`）で最終送信時刻を保持。60秒未満の再送は `429 too_many_requests`。
  - ⚠️ **プロセス内メモリのみ**（DB非永続化）。複数インスタンス運用時やプロセス再起動でリセットされる暫定実装。
- 対象顧客が存在しない、または既に`isVerified`済みの場合も**成功と同じ `{ ok: true }` を返す**（メールアドレスの存在有無を外部に漏らさないための意図的な設計）。
- 未認証の実在顧客のみ、新トークン・新有効期限を生成し直して上書き保存（＝古いトークンは自動失効し、常に有効なトークンは高々1つ）。再度確認メール送信。

### 1.6 機能制限ガード

`src/middleware/requireAuth.js:63-68` の `requireVerified` ミドルウェアが、SNS投稿・スケジュール作成・メンバー招待などの書き込み系APIに適用されており、`isVerified: false` のユーザーは `403 { error: "email_not_verified", message: "メール認証が完了していません" }` を返す。

### 1.7 SMTP送信基盤

- `src/lib/customerMailer.js`（nodemailer + 自社SMTP `mail.edgeailab.net` 経由）
- SMTP未設定時、送信関数自体は `{ok:false, error:"smtp_not_configured"}` を返すが、呼び出し元（signup等）は握りつぶして警告ログのみ出力し、APIレスポンスは成功扱いになる点に注意（ユーザーには「メールを送った」体で返る）。

### 1.8 関連環境変数

```
# メール送信（顧客向け認証系すべて共通）
SMTP_HOST=mail.edgeailab.net
SMTP_PORT=587
SMTP_USER=***
SMTP_PASSWORD=***
SMTP_FROM=info@edgeailab.net
MAIL_FROM_NAME=EdgeAI Lab

# 顧客データ（microCMS）
MICROCMS_SERVICE_DOMAIN=sns-poster
MICROCMS_WRITE_API_KEY / MICROCMS_API_KEY

# セッション
JWT_SECRET=***

# メール内リンク組み立て用ベースURL
APP_BASE_URL=https://edgeailab.net
```

---

## 2. 外部仕様（ユーザー向け）

### 2.1 API一覧

| メソッド/パス | 認証 | 概要 |
|---|---|---|
| `POST /api/auth/check-email` | 不要 | メール重複チェック（`{email}` → `{exists}`） |
| `POST /api/auth/signup` | 不要 | 新規登録＋確認メール送信＋即ログイン |
| `GET /api/auth/verify?token=` | トークン | メール確認完了処理（画面リダイレクト） |
| `POST /api/auth/resend-verification` | 不要 | 確認メール再送（`{email}` → `{ok:true}`） |
| `GET /api/auth/me` | Cookie | 自分の情報取得（`isVerified`含む） |

レスポンスは全て`application/json`。成功時 `{ ok: true, ... }`、失敗時 `{ error: "<code>" }` ＋適切なHTTPステータス。

### 2.2 画面フロー

1. **新規登録（`signup.html`）**
   - 入力項目: 会社名、担当者名（3文字以上）、メールアドレス、パスワード＋確認、プラン選択
   - パスワード要件をリアルタイムでチェックリスト表示
   - 登録成功後は**確認メールの到達を待たずに`dashboard.html`へ遷移**（未認証中も画面は使えるが一部機能は制限）
   - メール重複時（`409`）: 「このメールアドレスは既に登録されています。ログインはこちら」と表示

2. **ダッシュボード（`dashboard.html`）未認証バナー**
   - `isVerified: false` の場合、上部に警告バーを表示:
     > 「メールアドレスが未認証です。認証が完了するまでSNSへの投稿・メンバー招待などの機能が制限されます。」
   - 「認証メールを再送信」ボタン設置

3. **確認メール受信 → リンククリック**
   - ユーザー操作は**リンクをクリックするだけ**（コード入力なし）
   - 成功時は自動的に`dashboard.html`へ遷移しログイン状態が更新される

4. **エラー時の着地ページ（`verify-pending.html`）**
   - `?email=` でメールアドレス表示、`?error=` でエラーメッセージ出し分け:

     | error値 | 表示メッセージ |
     |---|---|
     | `missing_token` | 認証リンクが正しくありません。 |
     | `invalid_token` | 認証リンクが無効です。再送信してもう一度お試しください。 |
     | `expired_token` | 認証リンクの有効期限が切れています。再送信してください。 |
     | `internal_error` | 認証処理でエラーが発生しました。時間をおいて再度お試しください。 |
   - 「認証メールを再送する」ボタン（60秒のクールダウン表示付き）
   - 「メール未認証のまま続ける」リンクで`dashboard.html`へ

### 2.3 エラーケース一覧

| ケース | 発生箇所 | 応答 |
|---|---|---|
| メール形式不正 | signup等 | `400 invalid_email` |
| パスワード強度不足 | signup | `400 invalid_password` |
| メール重複登録（未解約） | signup | `409 email_exists` |
| 認証トークン欠落 | verify | `verify-pending.html?error=missing_token` |
| 認証トークン不一致 | verify | `?error=invalid_token` |
| 認証トークン期限切れ（24時間超） | verify | `?error=expired_token` |
| 再送信の連投（60秒未満） | resend-verification | `429 too_many_requests` |
| 未認証状態での機能利用 | 投稿/招待等 | `403 email_not_verified` |

### 2.4 有効期限・再送制限まとめ

| 項目 | 値 |
|---|---|
| 確認リンクの有効期限 | 24時間 |
| 再送信のクールダウン | 60秒 |
| トークン形式 | 64桁16進文字列（256bitランダム） |
| トークンの再利用 | 不可（認証成功時 or 再送信時に失効） |

---

## 3. 類似機能との関係

同じ「トークン発行 → DB保存 → メールリンク送付 → 検証 → 使用後クリア」パターンを踏襲している機能:

| 機能 | トークンTTL | 再送/要求制限 | 完了後の副作用 |
|---|---|---|---|
| **メールアドレス認証**（本機能） | 24時間 | 60秒 | `isVerified: true`、既存ログイン継続 |
| パスワードリセット（`forgot-password.html`→`reset-password.html`） | 1時間 | 3分（`PASSWORD_RESET_MIN_INTERVAL_MS`） | `sessionVersion`インクリメントで**全デバイスの既存セッションを無効化** |
| メンバー招待（`team.js`） | 7日間 | なし（管理者操作のため） | パスワード設定＋招待承諾で即ログイン |
| 投稿承認依頼（`approvals.js`） | 72時間 | - | 承認/却下結果を編集者に通知 |

- メール送信基盤（`sendCustomerMail` + `emailTemplates.js`のテンプレート集約）は完全共通化。
- トークン発行・検証ロジック自体は共通関数化されておらず、各ルートハンドラで同じパターンを個別実装（重複はあるが独立設計）。
- パスワードリセット・確認メール要求は、いずれも「メールアドレスの存在有無を外部に漏らさない」ため、対象有無に関わらず同一レスポンスを返す設計を統一して採用している。

---

## 4. 主要ファイル一覧

- `sns-poster/src/routes/auth.js` — signup / verify / resend-verification / request-password-reset / reset-password / login / logout / me
- `sns-poster/src/lib/customerStore.js` — microCMS `customers` CRUD（`markVerified`, `setPasswordResetToken`, `resetPassword`等）
- `sns-poster/src/lib/customerMailer.js` — SMTP送信ラッパー
- `sns-poster/src/lib/emailTemplates.js` — メール本文テンプレート集
- `sns-poster/src/lib/jwt.js` — セッションJWT発行/検証
- `sns-poster/src/middleware/requireAuth.js` — `requireAuth` / `requireVerified` ガード
- `sns-poster/src/routes/team.js` — メンバー招待（類似パターン）
- `sns-poster/.env.example` — 関連環境変数一覧
- `edgeailab.net/signup.html` — 登録フォーム
- `edgeailab.net/verify-pending.html` — 認証待ち・再送UI
- `edgeailab.net/dashboard.html` — 未認証バナー・再送ボタン
- `edgeailab.net/forgot-password.html` / `reset-password.html` — パスワードリセットUI（参考）
