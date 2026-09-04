#!/bin/sh
set -eu

# MOS package wrapper. Vaultwarden reads its SMTP settings straight from the
# environment, so the owner's shared relay (${smtp.*}) is passed in as SMTP_*
# directly by the manifest. The one value that does not line up is the encryption
# mode: Vaultwarden names it starttls / force_tls / off, where MOS uses the
# neutral startTls / implicitTls booleans. That translation lives here, in the
# package layer, so Vaultwarden's own vocabulary never leaks into MOS. With no
# relay configured SMTP_HOST is empty and Vaultwarden's mailer stays off, so the
# mapping is skipped and no SMTP_SECURITY is forced.
if [ -n "${SMTP_HOST:-}" ]; then
  if [ "${MOS_SMTP_IMPLICIT_TLS:-false}" = "true" ]; then
    export SMTP_SECURITY=force_tls
  elif [ "${MOS_SMTP_START_TLS:-false}" = "true" ]; then
    export SMTP_SECURITY=starttls
  else
    export SMTP_SECURITY=off
  fi
fi

# The base image has no ENTRYPOINT and starts via CMD ["/start.sh"]; /start.sh
# sets up the runtime and exec's /vaultwarden. Hand off to it unchanged.
exec /start.sh "$@"
