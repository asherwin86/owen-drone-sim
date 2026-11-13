# Drone Sim multiplayer relay.
#   docker build -t drone-sim-relay relay
#   docker run -d --restart unless-stopped -p 47832:47832 --name drone-sim-relay drone-sim-relay
FROM node:22-alpine
ENV NODE_ENV=production PORT=47832
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
USER node
EXPOSE 47832
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:47832/health || exit 1
CMD ["node", "server.js"]
