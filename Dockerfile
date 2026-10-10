FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tzdata
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
RUN addgroup -S -g 10250 studio && adduser -S -u 10250 -G studio studio && mkdir -p /app/data && chown studio:studio /app/data
USER studio
EXPOSE 3216 3217
CMD ["node", "server.js"]
