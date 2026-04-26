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

# Install routstrd-auth into the image.
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production
COPY src ./src

# routstrd listens inside the container on 8008.
# routstrd-auth is the public service exposed by Docker on 8080.
ENV ROUTSTRD_PORT=8008
ENV ROUTSTRD_AUTH_PORT=8080
ENV ROUTSTRD_AUTH_HOST=0.0.0.0
ENV ROUTSTRD_UPSTREAM=http://localhost:8008
ENV ROUTSTRD_AUTH_ADMIN_NPUBS=npub1l3m0300w4lph5kjfnvazgpj8wnv2tgpv9xdxft9qwt8ccmyz0v0s58tptp

VOLUME ["/data"]
EXPOSE 8080

# Healthcheck the public auth proxy, not the direct routstrd port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD bun -e "const p=process.env.ROUTSTRD_AUTH_PORT||8080;const r=await fetch('http://localhost:'+p+'/health');process.exit(r.ok?0:1)"

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
