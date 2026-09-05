FROM vaultwarden/server@sha256:094b5689ed81549bd293418395c7cf495ae9d960fc2d4928cef2083ef913d912

# MOS package wrapper:
# - Keeps the app self-contained under apps/vaultwarden.
# - Uses Vaultwarden's built-in SQLite storage for the first one-service package slice.
# - Wraps startup to translate the shared MOS email relay into Vaultwarden's own
#   SMTP_SECURITY vocabulary, then hands off to the image's /start.sh unchanged.
COPY entrypoint.sh /mos-entrypoint.sh
RUN sed -i 's/\r$//' /mos-entrypoint.sh && chmod +x /mos-entrypoint.sh
ENTRYPOINT ["/mos-entrypoint.sh"]
CMD []
