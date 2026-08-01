# Production Dockerfile for PM Synapse
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml .npmrc ./

# Install production dependencies
RUN pnpm install --frozen-lockfile --prod

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .

# Build Next.js and TypeScript server separately to ensure both succeed
RUN npx next build && npx tsc --project server/tsconfig.json

# Production image, copy all the files and run
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs

# Copy necessary files from builder
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js

# Copy production dependencies
COPY --from=deps /app/node_modules ./node_modules

# Create logs and uploads directories
RUN mkdir -p logs data/uploads && chown -R nodejs:nodejs logs data

USER nodejs

# Expose port
EXPOSE 3010

# Set environment variables
ENV PORT=3010
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3010/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "dist/server/index.js"]
