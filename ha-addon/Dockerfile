# Pinned here on purpose: Supervisor passes BUILD_FROM=its own base image
# (no Node), and build.yaml is deprecated (Supervisor 2026.10).
FROM node:22-alpine
ARG BUILD_VERSION
# Override for review, e.g. an HTTP server serving a branch's git archive.
ARG COREVIEW_TARBALL_URL
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tzdata \
    && addgroup -S -g 10250 studio \
    && adduser -S -u 10250 -G studio studio
RUN set -eu; \
    mkdir /tmp/coreview; \
    wget -O /tmp/coreview.tar.gz "${COREVIEW_TARBALL_URL:-https://github.com/2shepard2/CoreView/archive/refs/tags/v${BUILD_VERSION}.tar.gz}"; \
    tar -xzf /tmp/coreview.tar.gz -C /tmp/coreview --strip-components=1; \
    cp /tmp/coreview/package.json /tmp/coreview/server.js /app/; \
    cp -R /tmp/coreview/lib /tmp/coreview/public /app/; \
    rm -rf /tmp/coreview /tmp/coreview.tar.gz
COPY run.js /app/addon-run.js
# Start as root only to make Supervisor's /data mount writable by studio.
# run.js drops supplementary groups, GID and UID before starting the server.
EXPOSE 3216 3217
CMD ["node", "/app/addon-run.js"]
