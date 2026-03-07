FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

RUN apk add --no-cache sqlite su-exec

COPY . .

RUN addgroup -S coreview && adduser -S coreview -G coreview \
  && mkdir -p /app/data \
  && chown -R coreview:coreview /app

EXPOSE 3210

CMD ["sh", "-c", "chown -R coreview:coreview /app/data 2>/dev/null || true; exec su-exec coreview npm start"]
