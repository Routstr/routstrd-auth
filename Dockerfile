# syntax=docker/dockerfile:1
FROM cloudron/base:5.0.0@sha256:04fd70dbd8ad6149c19de39e35718e024417c3e01dc9c6637eaf4a41ec4e596c

USER root

# Install Bun into a location that remains readable/executable by the
# non-root cloudron user at runtime.
ENV BUN_INSTALL=/usr/local/bun
ENV PATH="/usr/local/bun/bin:/usr/local/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && curl -fsSL https://bun.sh/install | bash \
    && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install routstrd daemon + cocod wallet CLI globally. The global install lives
# under /usr/local/bun, not /root, so supervised processes running as cloudron
# can execute the binaries on Cloudron's read-only root filesystem.
RUN bun install --global @routstr/cocod routstrd \
    && ln -sf /usr/local/bun/bin/routstrd /usr/local/bin/routstrd \
    && ln -sf /usr/local/bun/bin/cocod /usr/local/bin/cocod \
    && test -f /usr/local/bun/install/global/node_modules/routstrd/dist/daemon/index.js

# Cloudron convention: immutable app code in /app/code, persistent data mounted
# by the platform at /app/data at runtime.
RUN mkdir -p /app/code
WORKDIR /app/code

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production
COPY src ./src

# Supervisor manages both long-running processes in the single Cloudron app
# container: routstrd on localhost:8009 and routstrd-auth on 0.0.0.0:8008.
COPY cloudron/supervisord.conf /etc/supervisor/supervisord-cloudron.conf
COPY cloudron/supervisor/routstrd.conf /etc/supervisor/conf.d/routstrd.conf
COPY cloudron/supervisor/auth.conf /etc/supervisor/conf.d/auth.conf

COPY cloudron/start.sh /app/code/start.sh
COPY cloudron/run-auth.sh /app/code/run-auth.sh
RUN chmod +x /app/code/start.sh /app/code/run-auth.sh

EXPOSE 8008

CMD ["/app/code/start.sh"]
