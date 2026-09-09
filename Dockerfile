# syntax=docker/dockerfile:1.7
# Semanggi Work Controller (POC-4 §9).
#
# Bun supplies the PostgreSQL, SQLite, Redis, HTTP, and WebSocket clients used
# by the controller; no package-manager install step is required.
FROM oven/bun:1.2.22-debian

# Non-root from the start. The controller creates no containers and holds no
# Docker socket; uid 1000 matches the NFS ownership the other services use.
RUN groupadd -g 1000 controller 2>/dev/null || true; \
    useradd -u 1000 -g 1000 -m -s /usr/sbin/nologin controller 2>/dev/null || true

WORKDIR /app
COPY --chown=1000:1000 controller/package.json ./package.json
COPY --chown=1000:1000 controller/src ./src
# Routing policy and resource catalogue ship with the image so a deploy is one
# artefact; both are also overridable by env for a hot policy change.
COPY --chown=1000:1000 controller/config ./config
COPY --chown=1000:1000 controller/scripts ./scripts

ENV NODE_ENV=production \
    PORT=8080 \
    SEMANGGI_DB=/opt/semanggi/volumes/shared/service/semanggios/controller/controller.db \
    SEMANGGI_ROUTING_CONFIG=/app/config/routing.json \
    SEMANGGI_RESOURCES_CONFIG=/app/config/resources.json

USER 1000:1000
EXPOSE 8080
# Health is unauthenticated by design (see api/server.mjs): the Swarm probe runs
# before any secret is available to it and the payload carries no state.
HEALTHCHECK --interval=30s --timeout=5s --retries=5 --start-period=20s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/work/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/main.mjs"]
