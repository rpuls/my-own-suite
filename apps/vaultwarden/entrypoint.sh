#!/bin/sh
set -eu

if [ "${SMTP_ENABLED+x}" = "x" ]; then
  smtp_enabled="$(printf '%s' "${SMTP_ENABLED}" | tr '[:upper:]' '[:lower:]')"

  case "${smtp_enabled}" in
    1|true|yes|on)
      ;;
    *)
      unset SMTP_HOST
      unset SMTP_FROM
      unset SMTP_FROM_NAME
      unset SMTP_USERNAME
      unset SMTP_PASSWORD
      unset SMTP_PORT
      unset SMTP_SECURITY
      ;;
  esac
fi

exec /start.sh "$@"
