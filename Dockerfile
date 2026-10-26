# Rezept-Agent: Claude Code ohne Bildschirm für Tandoor-Rezepte (Slack, Qualitätsprüfung)
# Autor: SebastianInTheWild · MIT-Lizenz
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

ENV AGENTS_DIR=/agents \
    DATA_DIR=/data \
    TZ=Europe/Berlin \
    DISABLE_AUTOUPDATER=1

WORKDIR /app
COPY app/ /app/
COPY agents/ /agents/
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME /data
CMD ["node", "/app/scheduler.mjs"]
