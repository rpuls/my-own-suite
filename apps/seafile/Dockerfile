FROM seafileltd/seafile-mc@sha256:1e335e704bb0159bd13f443c9c5ac20e72dd2bb47da3a8ab48be977cf30fc7bd

# MOS wrapper:
# - Applies proxy, SMTP, and OnlyOffice settings at container startup.
# - Allows overriding OnlyOffice callback behavior for private networks.
COPY entrypoint.sh /opt/seafile/entrypoint.sh
RUN sed -i 's/\r$//' /opt/seafile/entrypoint.sh && chmod +x /opt/seafile/entrypoint.sh

ENTRYPOINT ["/opt/seafile/entrypoint.sh"]
