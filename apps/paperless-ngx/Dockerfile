# Paperless-ngx 3.0.5.
FROM ghcr.io/paperless-ngx/paperless-ngx@sha256:49eba766581b9134cfa6b584b9eb718355fb9cfbd44b2a7c9c72a427d4891648

# The upstream image ships Tesseract data for eng, deu, fra, ita and spa only.
# PAPERLESS_OCR_LANGUAGES installs further languages at every container start,
# which needs the network at runtime; baking Dutch in keeps every OCR language
# the install form offers working from the pinned image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr-nld \
  && rm -rf /var/lib/apt/lists/*
