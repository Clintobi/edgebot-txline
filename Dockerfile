FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
ENV NODE_ENV=production

# Credential-free, wallet-free verification is the container default.
CMD ["npm", "run", "judge:verify"]
