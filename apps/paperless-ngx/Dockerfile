# Paperless-ngx 3.3.4.
FROM ghcr.io/paperless-ngx/paperless-ngx@sha256:9bc6e8248891bcfa6f52fffe8b81e4ea8cae75790c3ec1b9906961a7ba55c969

# The upstream image ships Tesseract data for eng, deu, fra, ita and spa only.
# PAPERLESS_OCR_LANGUAGES installs further languages at every container start,
# which needs the network at runtime; baking Dutch in keeps every OCR language
# the install form offers working from the pinned image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr-nld \
  && rm -rf /var/lib/apt/lists/*
