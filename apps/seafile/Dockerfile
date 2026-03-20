FROM seafileltd/seafile-mc@sha256:1239b087aa4bdf1b60a3802e80855f230736ac5d5fa3325a40b15d4c598f422c

# Railway compatibility wrapper:
# - Maps Railway MySQL variable names to Seafile's expected env names.
# - Allows overriding hardcoded memcached:11211 with Railway internal address.
COPY entrypoint.sh /opt/seafile/entrypoint.sh
RUN sed -i 's/\r$//' /opt/seafile/entrypoint.sh && chmod +x /opt/seafile/entrypoint.sh

ENTRYPOINT ["/opt/seafile/entrypoint.sh"]
