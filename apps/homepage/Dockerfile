# Homepage Dashboard Service
# Custom build that generates config from environment variables

# ============================================
# Stage 1: Build TypeScript Config Generator
# ============================================
FROM node@sha256:e3ffe0cbaeebdcddbfe1ee7bca9b564a92863a8386d5b99a3d72677b3667b61d AS builder

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
FROM ghcr.io/gethomepage/homepage@sha256:cc84f2f5eb3c7734353701ccbaa24ed02dacb0d119114e50e4251e2005f3990a

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
