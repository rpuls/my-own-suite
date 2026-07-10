FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 xorriso \
  && rm -rf /var/lib/apt/lists/*

COPY remaster-iso.sh /usr/local/bin/remaster-iso.sh

RUN chmod +x /usr/local/bin/remaster-iso.sh

ENTRYPOINT ["/usr/local/bin/remaster-iso.sh"]
