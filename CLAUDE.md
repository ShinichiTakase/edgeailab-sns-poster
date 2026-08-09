## 運用環境
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

## データ永続化
`json/client_tokens.json` はクライアントごとのSNSトークン置き場。
クライアント数が増えたらDB移行を検討する前提の暫定実装（[src/lib/tokenStore.js](src/lib/tokenStore.js)参照）。
