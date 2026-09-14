FROM vaultwarden/server@sha256:1587c45feaa479f1f5e8af3b00eded36bff77bcf1880cf8dbf0541706dd470e0

# MOS package wrapper:
# - Keeps the app self-contained under apps/vaultwarden.
# - Uses Vaultwarden's built-in SQLite storage for the first one-service package slice.
# - Wraps startup to translate the shared MOS email relay into Vaultwarden's own
#   SMTP_SECURITY vocabulary, then hands off to the image's /start.sh unchanged.
COPY entrypoint.sh /mos-entrypoint.sh
RUN sed -i 's/\r$//' /mos-entrypoint.sh && chmod +x /mos-entrypoint.sh
ENTRYPOINT ["/mos-entrypoint.sh"]
CMD []
