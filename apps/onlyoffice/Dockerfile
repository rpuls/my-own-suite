FROM onlyoffice/documentserver@sha256:53a06109f1f4029a78f913a061e14f01bff023d109024073a13d4416b54d2195

# Platform compatibility wrapper:
# - Supports binding nginx to platform-provided PORT.
# - Normalizes env values that may be wrapped in quotes by platform UIs.
COPY entrypoint.sh /opt/onlyoffice/entrypoint.sh
RUN sed -i 's/\r$//' /opt/onlyoffice/entrypoint.sh && chmod +x /opt/onlyoffice/entrypoint.sh

ENTRYPOINT ["/opt/onlyoffice/entrypoint.sh"]
