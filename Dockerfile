# syntax=docker/dockerfile:1

# ---- Build ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build && npm prune --omit=dev

# ---- Execução ----
FROM node:26-alpine
ARG JATOBA_VERSION=dev
ENV NODE_ENV=production \
    JATOBA_VERSION=${JATOBA_VERSION}
# pg_dump/psql na mesma versão maior do Postgres do compose, e age para criptografar os backups.
RUN apk add --no-cache postgresql16-client age \
 && printf '#!/bin/sh\nexec node /app/packages/web/dist/cli.js "$@"\n' > /usr/local/bin/jatoba \
 && chmod 755 /usr/local/bin/jatoba \
 && mkdir -p /backups && chown node:node /backups
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/web/package.json ./packages/web/
COPY --from=build /app/packages/web/dist ./packages/web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/web/dist/server.js"]
