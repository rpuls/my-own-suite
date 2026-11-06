# Paperless-ngx 3.4.0.
FROM ghcr.io/paperless-ngx/paperless-ngx@sha256:7c1d98afd200def9e2bad3a377d30829e8d486554b3c818995af5860114ea17f

# The upstream image ships Tesseract data for eng, deu, fra, ita and spa only.
# PAPERLESS_OCR_LANGUAGES installs further languages at every container start,
# which needs the network at runtime; baking Dutch in keeps every OCR language
# the install form offers working from the pinned image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr-nld \
  && rm -rf /var/lib/apt/lists/*
