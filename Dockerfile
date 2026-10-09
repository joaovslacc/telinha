FROM node:20-alpine
LABEL org.opencontainers.image.title="telinha" \
      org.opencontainers.image.description="Compartilhamento de tela entre poucas pessoas (WebRTC mesh)"
WORKDIR /app
ENV NODE_ENV=production PORT=3004 PUBLIC_DIR=/app/public
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/server.js ./server/
COPY public ./public
USER node
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3004/healthz >/dev/null || exit 1
CMD ["node", "--max-old-space-size=64", "server/server.js"]
