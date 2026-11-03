# Rezept-Agent: Claude Code ohne Bildschirm für Tandoor-Rezepte (Slack, Qualitätsprüfung)
# Fertig gebaut von GitHub Actions (.github/workflows/image.yml) als ghcr.io/sebastianinthewild/rezept-agent:latest
# Autor: SebastianInTheWild · MIT-Lizenz
FROM node:26-bookworm-slim

# ffmpeg + yt-dlp für Rezepte aus Reels/Shorts (yt-dlp als eigenständiges Programm, wird mit jedem Build aktuell)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates curl ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
 && chmod 755 /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

ENV AGENTS_DIR=/agents \
    DATA_DIR=/data \
    TZ=Europe/Berlin \
    DISABLE_AUTOUPDATER=1

WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/SebastianInTheWild/Rezept-Agent"
# Version (Zeitpunkt des Commits, „2026-11-03 10-11“), Commit und Bauzeit – für Weboberfläche, Slack und Log
# (setzt GitHub Actions; lokal gebaut: „dev“)
ARG APP_VERSION=dev
ARG APP_RELEASE=""
ARG APP_BUILD=""
ENV APP_VERSION=$APP_VERSION \
    APP_RELEASE="${APP_RELEASE}" \
    APP_BUILD=$APP_BUILD
COPY app/ /app/
COPY agents/ /agents/
COPY slack-app-manifest.yml /slack-app-manifest.yml
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME /data
# start.sh startet Zeitplan, Weboberfläche und Slack-Brücke
CMD ["sh", "/app/start.sh"]
