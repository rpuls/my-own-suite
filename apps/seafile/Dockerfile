FROM seafileltd/seafile-mc@sha256:f1e19cc1cdd52ed8ec883de114acaa1e932941515dd6571fce0c0ff02248c4cf

# Railway compatibility wrapper:
# - Maps Railway MySQL variable names to Seafile's expected env names.
# - Allows overriding hardcoded memcached:11211 with Railway internal address.
COPY entrypoint.sh /opt/seafile/entrypoint.sh
RUN sed -i 's/\r$//' /opt/seafile/entrypoint.sh && chmod +x /opt/seafile/entrypoint.sh

ENTRYPOINT ["/opt/seafile/entrypoint.sh"]
