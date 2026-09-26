FROM onlyoffice/documentserver@sha256:3ab6ebc7c605e5a32b7ae3ff19daed4925090245acc8100ce2230bd766c88212

# Platform compatibility wrapper:
# - Supports binding nginx to platform-provided PORT.
# - Normalizes env values that may be wrapped in platform UIs.
COPY entrypoint.sh /opt/onlyoffice/entrypoint.sh
RUN sed -i 's/\r$//' /opt/onlyoffice/entrypoint.sh && chmod +x /opt/onlyoffice/entrypoint.sh

ENTRYPOINT ["/opt/onlyoffice/entrypoint.sh"]
