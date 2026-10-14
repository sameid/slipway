# Built by the platform's build-release step from the repo root (npm workspaces
# share one lockfile):
#   docker build --platform linux/amd64 -f api/Dockerfile .
# The base image comes from ECR Public to avoid Docker Hub rate limits.

FROM public.ecr.aws/docker/library/node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --workspace api --ignore-scripts
COPY api api
RUN npm run build --workspace api

FROM public.ecr.aws/docker/library/node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
RUN npm ci --workspace api --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/api/dist api/dist
COPY api/drizzle api/drizzle
# RDS requires TLS; trust its CA bundle.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
ENV DB_SSL_CA=/app/rds-global-bundle.pem
WORKDIR /app/api
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
