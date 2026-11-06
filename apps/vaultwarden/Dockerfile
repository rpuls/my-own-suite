FROM vaultwarden/server@sha256:4fe17f415f90087377d37c755e0ea3cf189dcc6794e49cdd2a9adbb4937d9e1f

# MOS package wrapper:
# - Keeps the app self-contained under apps/vaultwarden.
# - Uses Vaultwarden's built-in SQLite storage for the first one-service package slice.
# - Wraps startup to translate the shared MOS email relay into Vaultwarden's own
#   SMTP_SECURITY vocabulary, then hands off to the image's /start.sh unchanged.
COPY entrypoint.sh /mos-entrypoint.sh
RUN sed -i 's/\r$//' /mos-entrypoint.sh && chmod +x /mos-entrypoint.sh
ENTRYPOINT ["/mos-entrypoint.sh"]
CMD []
