# Container image for the candidate-registry / data-provider app.
# Works on any container host (Fly.io, Railway, Render, Google Cloud Run, a VPS).
FROM node:22-alpine

WORKDIR /app

# Install deps first (better layer caching). Includes the optional `pg` driver
# so DATABASE_URL (Postgres) works in production.
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY . .

# Hosts inject PORT; the server reads process.env.PORT.
ENV NODE_ENV=production
EXPOSE 8080
ENV PORT=8080

# Health check hits the app's /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
