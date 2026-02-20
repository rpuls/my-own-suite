FROM onlyoffice/documentserver:latest

# Keep admin panel available by default for service diagnostics/setup.
RUN sed -i "s/autostart=false/autostart=true/g" /etc/supervisor/conf.d/ds-adminpanel.conf

# Platform compatibility wrapper:
# - Supports binding nginx to platform-provided PORT.
# - Normalizes env values that may be wrapped in quotes by platform UIs.
COPY entrypoint.sh /opt/onlyoffice/entrypoint.sh
RUN chmod +x /opt/onlyoffice/entrypoint.sh

ENTRYPOINT ["/opt/onlyoffice/entrypoint.sh"]
