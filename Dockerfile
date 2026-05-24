FROM node:24-trixie-slim AS build

WORKDIR /app

COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run typecheck && npm test && npm run build
RUN npm prune --omit=dev

FROM node:24-trixie-slim AS runtime

ENV NODE_ENV=production
ENV LAN_VOTE_HOST=0.0.0.0
ENV LAN_VOTE_PORT=8080
ENV LAN_VOTE_DB_PATH=/app/data/lan-vote.sqlite

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8080
VOLUME ["/app/data"]

CMD ["node", "dist/server/index.js"]
