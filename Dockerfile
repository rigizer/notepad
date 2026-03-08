# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JS and static assets
COPY --from=builder /app/dist ./dist
COPY public ./public

# Persistent data directory (mounted as a volume in production)
RUN mkdir -p /app/data

EXPOSE 5050

CMD ["node", "dist/server.js"]
