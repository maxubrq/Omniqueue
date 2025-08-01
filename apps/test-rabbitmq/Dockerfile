FROM node:21-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install pnpm --global
COPY . .
RUN pnpm i
RUN pnpm run build
CMD ["node", "dist/app.js", "produce"]