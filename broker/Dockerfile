# BnF broker — minimal Node service (tsx, no build step).
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm install -g tsx@4
COPY tsconfig.json ./
COPY src ./src
EXPOSE 8792
# Secrets (BNF_CLIENT_KEY/SECRET) injected at runtime — never baked into the image.
CMD ["tsx", "src/server.ts"]
