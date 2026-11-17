# Paperless-ngx 3.4.2.
FROM ghcr.io/paperless-ngx/paperless-ngx@sha256:d704e84f88300eb6ab001ab15720a2330ff99169cf9f94d6b8fcc44b63a84c84

# The upstream image ships Tesseract data for eng, deu, fra, ita and spa only.
# PAPERLESS_OCR_LANGUAGES installs further languages at every container start,
# which needs the network at runtime; baking Dutch in keeps every OCR language
# the install form offers working from the pinned image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr-nld \
  && rm -rf /var/lib/apt/lists/*
