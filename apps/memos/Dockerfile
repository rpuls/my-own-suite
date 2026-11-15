# Memos 26.11.0.
FROM ghcr.io/usememos/memos@sha256:087e7dc6b76b31fcd1107a5767398b2a310ced209adb791efd8760c745dc8034

COPY registration.json /etc/memos/config/registration.json
# MOS package snapshots are 0600 root, and Memos reads its config after dropping to UID 10001.
RUN chmod 0644 /etc/memos/config/registration.json
