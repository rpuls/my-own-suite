FROM seafileltd/seafile-mc@sha256:b0c90832126bf432db908449f1bb450211e6bbf75a2193bab3399e2a9636eccf

# MOS wrapper: keep Seafile core behind the generated app route and patch
# proxy-facing Seahub settings plus declared document-editor integration config.
COPY entrypoint.sh /opt/seafile/entrypoint.sh
RUN sed -i 's/\r$//' /opt/seafile/entrypoint.sh && chmod +x /opt/seafile/entrypoint.sh

ENTRYPOINT ["/opt/seafile/entrypoint.sh"]
