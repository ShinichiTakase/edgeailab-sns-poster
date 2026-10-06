FROM node:20-alpine

ARG APP_REVISION=unknown
ARG APP_VERSION=untagged
LABEL org.opencontainers.image.revision=$APP_REVISION \
      org.opencontainers.image.version=$APP_VERSION
ENV APP_REVISION=$APP_REVISION APP_VERSION=$APP_VERSION

# ffmpeg: Instagram動画生成のエンコードに使用。
# font-noto-cjk: 動画のテキスト描画（日本語）に使用（@napi-rs/canvasから
# GlobalFonts.registerFromPathで/usr/share/fonts/noto/NotoSansCJK-*.ttcを直接登録する）。
RUN apk add --no-cache tzdata ffmpeg font-noto-cjk
ENV TZ=Asia/Tokyo

WORKDIR /app

# 全API/one-shot containerで同じfreeze状態を見るため、共有data mount上の
# markerを運用上の固定pathから参照する。リンク先は通常存在しない。
RUN ln -s /app/data/.write-freeze /run/edgeailab-sns-poster-write-freeze

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config ./config
COPY bgm ./bgm
COPY assets ./assets

EXPOSE 3000

CMD ["node", "src/index.js"]
