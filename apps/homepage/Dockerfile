# Homepage Dashboard Service
# Custom build that generates config from environment variables

# ============================================
# Stage 1: Build TypeScript Config Generator
# ============================================
FROM node@sha256:09e2b3d9726018aecf269bd35325f46bf75046a643a66d28360ec71132750ec8 AS builder

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
FROM ghcr.io/gethomepage/homepage@sha256:9627769818fbfb14147d3e633e57cef9c27c0c5f07585f5a1d6c3d3425b3b33c

# Copy built config generator (only production dependencies needed at runtime)
COPY --from=builder /build/dist /app/config-generator/dist
COPY --from=builder /build/node_modules/yaml /app/config-generator/node_modules/yaml
COPY --from=builder /build/package.json /app/config-generator/

# Copy static config files (bookmarks, widgets, etc.)
COPY config/ /app/config/
COPY icons/ /app/icon-seed/

# Copy simplified entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Expose the default port
EXPOSE 3000

# Use custom entrypoint
ENTRYPOINT ["/entrypoint.sh"]
