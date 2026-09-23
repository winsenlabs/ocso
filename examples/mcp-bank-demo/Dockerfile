# Meridian core — an EXAMPLE external business system exposed over MCP (not part of OCSO core).
#
# Build from the repository root (it is a pnpm workspace member):
#   docker build -f examples/mcp-bank-demo/Dockerfile -t meridian-core-mcp .
# Run:
#   docker run --rm -p 4100:4100 -e DEMO_MCP_TOKEN=<long-random-token> meridian-core-mcp
#
# Only the files needed are copied (works with the classic builder and with BuildKit, which also
# honours Dockerfile.dockerignore next to this file).
ARG NODE_IMAGE=node:26-alpine

FROM ${NODE_IMAGE} AS build
# Node 26 images no longer bundle corepack; pin pnpm to the workspace's packageManager version.
RUN npm install -g pnpm@11.1.2 && npm cache clean --force
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY examples/mcp-bank-demo/package.json examples/mcp-bank-demo/tsconfig.build.json examples/mcp-bank-demo/
RUN pnpm install --frozen-lockfile --filter ocso --filter @ocso-examples/mcp-bank-demo
COPY examples/mcp-bank-demo/src examples/mcp-bank-demo/src
RUN pnpm --filter @ocso-examples/mcp-bank-demo run build \
 && pnpm --filter @ocso-examples/mcp-bank-demo deploy --prod --legacy /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=4100 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/examples/mcp-bank-demo/dist ./dist
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
