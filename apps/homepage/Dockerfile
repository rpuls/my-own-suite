# Homepage Dashboard Service
# Custom build that generates config from environment variables

# ============================================
# Stage 1: Build TypeScript Config Generator
# ============================================
FROM node@sha256:2e45682ea560ac050cca0fd1ff5e82457a717a98e95e30bbf93306833a31332c AS builder

WORKDIR /build

# Copy package files and install dependencies (including devDependencies for build)
COPY config-generator/package*.json ./
RUN npm ci

# Copy source and build
COPY config-generator/tsconfig.json ./
COPY config-generator/src/ ./src/
RUN npm run build

# ============================================
# Stage 2: Runtime Image
# ============================================
FROM ghcr.io/gethomepage/homepage@sha256:0b596092c0b55fe4c65379a428a3fe90bd192f10d1b07d189a34fe5fabe7eedb

# Copy built config generator (only production dependencies needed at runtime)
COPY --from=builder /build/dist /app/config-generator/dist
COPY --from=builder /build/node_modules/yaml /app/config-generator/node_modules/yaml
COPY --from=builder /build/package.json /app/config-generator/

# Copy static config files (bookmarks, widgets, etc.)
COPY config/ /app/config/

# Copy simplified entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Expose the default port
EXPOSE 3000

# Use custom entrypoint
ENTRYPOINT ["/entrypoint.sh"]
