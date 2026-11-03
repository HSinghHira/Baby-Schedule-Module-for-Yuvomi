# Baby Schedule sidecar. No npm dependencies: Node's built-in HTTP server
# and node:sqlite are all it uses.
FROM node:24-alpine

# su-exec: drop from root to "node" after fixing the data folder's owner.
RUN apk add --no-cache su-exec

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY entrypoint.sh /usr/local/bin/baby-schedule-entrypoint
RUN chmod +x /usr/local/bin/baby-schedule-entrypoint \
 && sed -i 's/\r$//' /usr/local/bin/baby-schedule-entrypoint \
 && mkdir -p /data && chown -R node:node /data

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/extensions/baby-schedule/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["baby-schedule-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
