FROM seafileltd/seafile-mc@sha256:1e335e704bb0159bd13f443c9c5ac20e72dd2bb47da3a8ab48be977cf30fc7bd

# MOS V2 wrapper: keep Seafile core behind the generated app route and patch
# proxy-facing Seahub settings without carrying V1 OnlyOffice integration code.
COPY entrypoint.sh /opt/seafile/entrypoint.sh
RUN sed -i 's/\r$//' /opt/seafile/entrypoint.sh && chmod +x /opt/seafile/entrypoint.sh

ENTRYPOINT ["/opt/seafile/entrypoint.sh"]
