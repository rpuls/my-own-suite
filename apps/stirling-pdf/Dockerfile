FROM stirlingtools/stirling-pdf@sha256:f5a38801f2dd551c26d0089ee3ea48d86a565e3adb414cb31e974bc9562cb48a

# MOS package wrapper:
# - Keeps the app self-contained under apps/stirling-pdf.
# - Keeps the web client's PostHog and Stripe on Stirling's own server (patch-web-client.py).
COPY patch-web-client.py /tmp/patch-web-client.py
RUN python3 /tmp/patch-web-client.py && rm /tmp/patch-web-client.py
