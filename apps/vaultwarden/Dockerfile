FROM vaultwarden/server@sha256:e6443e3d5ed8fcee2204b89ec778d7f24d0173bcc42d1ea34f990304f5f63f51

# MOS package wrapper:
# - Keeps the app self-contained under apps/vaultwarden.
# - Uses Vaultwarden's built-in SQLite storage for the first one-service package slice.
# - Wraps startup to translate the shared MOS email relay into Vaultwarden's own
#   SMTP_SECURITY vocabulary, then hands off to the image's /start.sh unchanged.
COPY entrypoint.sh /mos-entrypoint.sh
RUN sed -i 's/\r$//' /mos-entrypoint.sh && chmod +x /mos-entrypoint.sh
ENTRYPOINT ["/mos-entrypoint.sh"]
CMD []
