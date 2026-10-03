FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    CONFIG_PATH=/config/dashboard.json

WORKDIR /app
# No npm dependencies: the server uses only Node built-ins.
COPY package.json ./
COPY server ./server
COPY public ./public
COPY config/dashboard.example.json ./config/dashboard.example.json

USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server/index.js"]
