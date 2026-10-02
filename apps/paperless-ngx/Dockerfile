# Paperless-ngx 3.1.3.
FROM ghcr.io/paperless-ngx/paperless-ngx@sha256:5fa76604a81df6945086e0837b14b56543d137e8ce4f311cc5d9ebe907e74e79

# The upstream image ships Tesseract data for eng, deu, fra, ita and spa only.
# PAPERLESS_OCR_LANGUAGES installs further languages at every container start,
# which needs the network at runtime; baking Dutch in keeps every OCR language
# the install form offers working from the pinned image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr-nld \
  && rm -rf /var/lib/apt/lists/*
