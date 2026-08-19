FROM node:20-alpine

# ffmpeg: Instagram動画生成のエンコードに使用。
# font-noto-cjk: 動画のテキスト描画（日本語）に使用（@napi-rs/canvasから
# GlobalFonts.registerFromPathで/usr/share/fonts/noto/NotoSansCJK-*.ttcを直接登録する）。
RUN apk add --no-cache tzdata ffmpeg font-noto-cjk
ENV TZ=Asia/Tokyo

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY config ./config
COPY bgm ./bgm

EXPOSE 3000

CMD ["node", "src/index.js"]
