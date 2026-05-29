# Homepage Dashboard Service
# Custom build that generates config from environment variables

# ============================================
# Stage 1: Build TypeScript Config Generator
# ============================================
FROM node@sha256:c69f4e0640e5b065f2694579793e4309f1e0e49868b0f2fea29c44d9c0dc2caf AS builder

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
FROM ghcr.io/gethomepage/homepage@sha256:d8d784e5090111b6e4c56dfd90e272d2953a2094e87349f647165df0fa6c4401

# Copy built config generator (only production dependencies needed at runtime)
COPY --from=builder /build/dist /app/config-generator/dist
COPY --from=builder /build/node_modules/yaml /app/config-generator/node_modules/yaml
COPY --from=builder /build/package.json /app/config-generator/

# Copy static config files as immutable seed material. Runtime config lives in
# the writable /app/config volume and is seeded by entrypoint.sh.
COPY config/ /app/default-config/
COPY icons/ /app/icon-seed/

# Copy simplified entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN mkdir -p /app/config \
    && sed -i 's/\r$//' /entrypoint.sh \
    && chmod +x /entrypoint.sh

# Expose the default port
EXPOSE 3000

# Use custom entrypoint
ENTRYPOINT ["/entrypoint.sh"]
