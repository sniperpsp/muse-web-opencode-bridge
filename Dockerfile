FROM node:22-bookworm-slim
ENV DISPLAY=:99 \
  MUSE_BRIDGE_HOST=0.0.0.0 \
  MUSE_BRIDGE_DATA=/data \
  MUSE_AUTH_BROWSER=1 \
  MUSE_CHROMIUM_BIN=/usr/lib/chromium/chromium \
  MUSE_VNC_URL=http://127.0.0.1:4318/vnc.html?autoconnect=1&resize=scale&host=127.0.0.1&port=4318&path=websockify

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium ca-certificates fluxbox fonts-liberation fonts-noto-color-emoji \
    novnc websockify x11vnc xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o node -g node /data /app

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod 0755 ./docker/entrypoint.sh

ARG MUSE_BUILD_REVISION=unknown
ENV MUSE_BUILD_REVISION=$MUSE_BUILD_REVISION
USER node
EXPOSE 4317 7900
ENTRYPOINT ["./docker/entrypoint.sh"]
