# Image tooling that does not need Administrator on the host: qemu-img reads
# Hyper-V's VHDX directly, and mtools reads the ESP out of the converted raw
# image at a byte offset without a loop device.
FROM ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea

ENV DEBIAN_FRONTEND=noninteractive
# mtools otherwise refuses ESPs whose geometry is not a whole number of tracks,
# which is most of them.
ENV MTOOLS_SKIP_CHECK=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends qemu-utils mtools fdisk gdisk e2fsprogs xz-utils \
  && rm -rf /var/lib/apt/lists/*

COPY check-target.sh /usr/local/bin/check-target.sh
COPY extract-image.sh /usr/local/bin/extract-image.sh
COPY inspect-image.sh /usr/local/bin/inspect-image.sh
COPY shrink-image.sh /usr/local/bin/shrink-image.sh
RUN chmod +x /usr/local/bin/check-target.sh /usr/local/bin/extract-image.sh \
  /usr/local/bin/inspect-image.sh /usr/local/bin/shrink-image.sh

WORKDIR /work
