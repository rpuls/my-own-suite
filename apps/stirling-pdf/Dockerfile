FROM stirlingtools/stirling-pdf@sha256:4d9abedcd57a9aa4d36ffb8fc9a4801aea2d295bf6ad349e23dd4b45661a5e42

# MOS package wrapper:
# - Keeps the app self-contained under apps/stirling-pdf.
# - Keeps the web client's PostHog and Stripe on Stirling's own server (patch-web-client.py).
COPY patch-web-client.py /tmp/patch-web-client.py
RUN python3 /tmp/patch-web-client.py && rm /tmp/patch-web-client.py
