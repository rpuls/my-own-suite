FROM seafileltd/seafile-mc:11.0-latest

# Railway compatibility wrapper:
# - Maps Railway MySQL variable names to Seafile's expected env names.
# - Allows overriding hardcoded memcached:11211 with Railway internal address.
COPY entrypoint.sh /opt/seafile/entrypoint.sh
RUN chmod +x /opt/seafile/entrypoint.sh

ENTRYPOINT ["/opt/seafile/entrypoint.sh"]
