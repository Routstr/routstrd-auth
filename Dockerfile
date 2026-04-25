# syntax=docker/dockerfile:1
FROM oven/bun:1.2

USER root

# Install routstrd daemon + cocod wallet CLI globally
# Both are published to npm; bun handles dependencies automatically
RUN bun install --global @routstr/cocod routstrd

# Make global bun binaries available on PATH
ENV PATH="/root/.bun/bin:${PATH}"

# Persistent data directory:
# - routstrd config, sqlite db, logs, pid/socket files (ROUTSTRD_DIR)
# - cocod wallet data (via HOME)
ENV HOME=/data
ENV ROUTSTRD_DIR=/data
RUN mkdir -p /data && chmod 755 /data

VOLUME ["/data"]
EXPOSE 8008

# Healthcheck using Bun itself (no curl needed)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r=await fetch('http://localhost:8008/health');process.exit(r.ok?0:1)"

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["--port", "8008"]
