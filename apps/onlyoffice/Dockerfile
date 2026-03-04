FROM onlyoffice/documentserver@sha256:e0a74be8c96fa91a9f55855e86ffb6d4d247d4c8d19dfaef7f441890a1bdbfd3

# Platform compatibility wrapper:
# - Supports binding nginx to platform-provided PORT.
# - Normalizes env values that may be wrapped in quotes by platform UIs.
COPY entrypoint.sh /opt/onlyoffice/entrypoint.sh
RUN sed -i 's/\r$//' /opt/onlyoffice/entrypoint.sh && chmod +x /opt/onlyoffice/entrypoint.sh

ENTRYPOINT ["/opt/onlyoffice/entrypoint.sh"]
