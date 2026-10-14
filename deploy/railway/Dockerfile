# Vera gateway for Railway: stock OpenClaw image plus the bundled Vera plugin.
# Build context is the directory produced by build.sh (Dockerfile, start.sh,
# railway.json, and vera/). Railway passes service variables with matching
# names as build args, so either pin can be overridden without editing this file.
ARG OPENCLAW_VERSION=2026.9.9
FROM docker.io/openclaw/openclaw:${OPENCLAW_VERSION}

# Kapso WhatsApp channel plugin version installed from ClawHub on first boot
# (and replaced on boot when the volume holds a different version).
ARG KAPSO_PLUGIN_VERSION=0.1.4
ENV KAPSO_PLUGIN_VERSION=${KAPSO_PLUGIN_VERSION}

# The volume at /data is root-owned, and the plugin loader rejects plugin files
# owned by another uid, so everything here stays root:root.
USER root
COPY vera /opt/lexroom/vera
COPY start.sh /opt/lexroom/start.sh
RUN command -v bash >/dev/null \
  && chmod 755 /opt/lexroom/start.sh \
  && chown -R root:root /opt/lexroom

ENTRYPOINT ["tini", "-s", "--"]
CMD ["/opt/lexroom/start.sh"]
