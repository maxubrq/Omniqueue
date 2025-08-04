FROM node:21-alpine AS builder

RUN apk --no-cache add \
      bash \
      g++ \
      ca-certificates \
      lz4-dev \
      musl-dev \
      cyrus-sasl-dev \
      openssl-dev \
      make \
      python3

RUN apk add --no-cache --virtual .build-deps gcc zlib-dev libc-dev bsd-compat-headers py-setuptools bash

WORKDIR /app
COPY package*.json ./
RUN npm install pnpm --global
COPY . .
RUN pnpm i --dangerously-allow-all-builds
RUN pnpm run build
CMD ["node", "dist/app.js", "produce"]