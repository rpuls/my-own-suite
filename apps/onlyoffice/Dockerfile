FROM onlyoffice/documentserver@sha256:e3da62a847b9a5d51a11f73cfea1d9c13c3be3809614490d4edddcf01dcf919b

# Platform compatibility wrapper:
# - Supports binding nginx to platform-provided PORT.
# - Normalizes env values that may be wrapped in quotes by platform UIs.
COPY entrypoint.sh /opt/onlyoffice/entrypoint.sh
RUN sed -i 's/\r$//' /opt/onlyoffice/entrypoint.sh && chmod +x /opt/onlyoffice/entrypoint.sh

ENTRYPOINT ["/opt/onlyoffice/entrypoint.sh"]
