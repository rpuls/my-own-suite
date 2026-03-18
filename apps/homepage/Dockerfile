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
FROM ghcr.io/gethomepage/homepage@sha256:b129cb0f674bd6d204e215bde2c2fc3f11d6ad0e82f6d20007cf80f74e1acbb1

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
