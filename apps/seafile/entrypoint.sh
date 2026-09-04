#!/bin/sh
set -eu

SEAHUB_SETTINGS_FILE="/shared/seafile/conf/seahub_settings.py"
SEAFDAV_SETTINGS_FILE="/shared/seafile/conf/seafdav.conf"

# Some hosts expose a syslog-ng version older than the syntax bundled in this
# image. Normalize it before the upstream init process starts.
if [ -f /etc/syslog-ng/syslog-ng.conf ]; then
  sed -i "s/@version: 4.3/@version: 3.35/g" /etc/syslog-ng/syslog-ng.conf || true
  sed -i "s/stats(freq(0));/stats_freq(0);/g" /etc/syslog-ng/syslog-ng.conf || true
fi

upsert_setting() {
  file="$1"
  key="$2"
  line="$3"
  if grep -q "^${key}[[:space:]]*=" "$file"; then
    sed -i "s|^${key}[[:space:]]*=.*|${line}|g" "$file"
  else
    echo "$line" >> "$file"
  fi
}

patch_seahub_proxy_settings() {
  if [ ! -f "$SEAHUB_SETTINGS_FILE" ]; then
    return 0
  fi

  protocol="${SEAFILE_SERVER_PROTOCOL:-http}"

  if [ -n "${SEAFILE_SERVER_HOSTNAME:-}" ]; then
    upsert_setting "$SEAHUB_SETTINGS_FILE" "SERVICE_URL" "SERVICE_URL = \"${protocol}://${SEAFILE_SERVER_HOSTNAME}\""
    upsert_setting "$SEAHUB_SETTINGS_FILE" "FILE_SERVER_ROOT" "FILE_SERVER_ROOT = \"${protocol}://${SEAFILE_SERVER_HOSTNAME}/seafhttp\""
    upsert_setting "$SEAHUB_SETTINGS_FILE" "CSRF_TRUSTED_ORIGINS" "CSRF_TRUSTED_ORIGINS = ['https://${SEAFILE_SERVER_HOSTNAME}', 'http://${SEAFILE_SERVER_HOSTNAME}']"
  fi

  upsert_setting "$SEAHUB_SETTINGS_FILE" "SECURE_PROXY_SSL_HEADER" "SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "USE_X_FORWARDED_HOST" "USE_X_FORWARDED_HOST = True"
}

# The image's nginx already proxies /seafdav/ to the daemon; only the enabled
# flag keeps WebDAV off. share_name must match the proxied path.
patch_seafdav_settings() {
  if [ ! -f "$SEAFDAV_SETTINGS_FILE" ]; then
    return 0
  fi

  upsert_setting "$SEAFDAV_SETTINGS_FILE" "enabled" "enabled = true"
  upsert_setting "$SEAFDAV_SETTINGS_FILE" "share_name" "share_name = /seafdav"
}

patch_seahub_onlyoffice_settings() {
  if [ ! -f "$SEAHUB_SETTINGS_FILE" ]; then
    return 0
  fi

  to_python_bool() {
    case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in
      1|true|yes|on) echo "True" ;;
      *) echo "False" ;;
    esac
  }

  is_non_falsy_string() {
    case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in
      ""|0|false|no|off|null|none) return 1 ;;
      *) return 0 ;;
    esac
  }

  verify_onlyoffice_cert="${VERIFY_ONLYOFFICE_CERTIFICATE:-false}"
  onlyoffice_apijs_url="${ONLYOFFICE_APIJS_URL:-}"
  onlyoffice_force_save="${ONLYOFFICE_FORCE_SAVE:-true}"
  onlyoffice_internal_seafile_url="${ONLYOFFICE_INTERNAL_SEAFILE_URL:-}"

  if is_non_falsy_string "$onlyoffice_apijs_url"; then
    enable_onlyoffice="true"
  else
    enable_onlyoffice="false"
  fi

  upsert_setting "$SEAHUB_SETTINGS_FILE" "ENABLE_ONLYOFFICE" "ENABLE_ONLYOFFICE = $(to_python_bool "$enable_onlyoffice")"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "VERIFY_ONLYOFFICE_CERTIFICATE" "VERIFY_ONLYOFFICE_CERTIFICATE = $(to_python_bool "$verify_onlyoffice_cert")"

  if is_non_falsy_string "$onlyoffice_apijs_url"; then
    upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_APIJS_URL" "ONLYOFFICE_APIJS_URL = '${onlyoffice_apijs_url}'"
  fi

  upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_FILE_EXTENSION" "ONLYOFFICE_FILE_EXTENSION = ('doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'fodt', 'odp', 'fodp', 'ods', 'fods', 'csv', 'ppsx', 'pps')"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_EDIT_FILE_EXTENSION" "ONLYOFFICE_EDIT_FILE_EXTENSION = ('docx', 'pptx', 'xlsx')"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_FORCE_SAVE" "ONLYOFFICE_FORCE_SAVE = $(to_python_bool "$onlyoffice_force_save")"

  if [ -n "${ONLYOFFICE_JWT_SECRET:-}" ]; then
    upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_JWT_SECRET" "ONLYOFFICE_JWT_SECRET = '${ONLYOFFICE_JWT_SECRET}'"
  fi

  if is_non_falsy_string "$onlyoffice_internal_seafile_url"; then
    upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_INTERNAL_SEAFILE_URL" "ONLYOFFICE_INTERNAL_SEAFILE_URL = '${onlyoffice_internal_seafile_url}'"
  fi
}

patch_seahub_onlyoffice_runtime() {
  onlyoffice_utils_file="/opt/seafile/seafile-server-latest/seahub/seahub/onlyoffice/utils.py"
  onlyoffice_views_file="/opt/seafile/seafile-server-latest/seahub/seahub/onlyoffice/views.py"
  if [ ! -f "$onlyoffice_utils_file" ]; then
    return 0
  fi

  if ! grep -q "_get_onlyoffice_internal_seafile_url" "$onlyoffice_utils_file"; then
    sed -i "/logger = logging.getLogger('onlyoffice')/a\\
\\
import seahub.settings as seahub_settings\\
\\
def _get_onlyoffice_internal_seafile_url():\\
    base_url = getattr(seahub_settings, 'ONLYOFFICE_INTERNAL_SEAFILE_URL', '')\\
    return base_url.rstrip('/')\\
" "$onlyoffice_utils_file"

    sed -i "/doc_url = gen_file_get_url(dl_token, file_name)/a\\
\\
    internal_seafile_url = _get_onlyoffice_internal_seafile_url()\\
    if internal_seafile_url:\\
        fileserver_root = getattr(seahub_settings, 'FILE_SERVER_ROOT', '').rstrip('/')\\
        internal_fileserver_root = internal_seafile_url + '/seafhttp'\\
        if doc_url.startswith(fileserver_root + '/'):\\
            doc_url = internal_fileserver_root + doc_url[len(fileserver_root):]\\
" "$onlyoffice_utils_file"

    sed -i "s/base_url = get_site_scheme_and_netloc()/base_url = internal_seafile_url if internal_seafile_url else get_site_scheme_and_netloc()/g" "$onlyoffice_utils_file"
  fi

  if [ -f "$onlyoffice_views_file" ] && ! grep -q "_rewrite_onlyoffice_file_url_for_internal_callback" "$onlyoffice_views_file"; then
    if ! grep -q "ONLYOFFICE_APIJS_URL" "$onlyoffice_views_file"; then
      sed -i "s/from seahub.onlyoffice.settings import VERIFY_ONLYOFFICE_CERTIFICATE, ONLYOFFICE_JWT_SECRET/from seahub.onlyoffice.settings import VERIFY_ONLYOFFICE_CERTIFICATE, ONLYOFFICE_JWT_SECRET, ONLYOFFICE_APIJS_URL/g" "$onlyoffice_views_file"
      sed -i "s/ONLYOFFICE_JWT_SECRET, ONLYOFFICE_FILE_EXTENSION/ONLYOFFICE_JWT_SECRET, ONLYOFFICE_APIJS_URL, ONLYOFFICE_FILE_EXTENSION/g" "$onlyoffice_views_file"
    fi

    sed -i "/logger = logging.getLogger('onlyoffice')/a\\
\\
def _rewrite_onlyoffice_file_url_for_internal_callback(url):\\
    if not url:\\
        return url\\
\\
    try:\\
        parsed_url = urllib.parse.urlparse(url)\\
        api_js_url = urllib.parse.urlparse(ONLYOFFICE_APIJS_URL)\\
\\
        if not api_js_url.scheme or not api_js_url.netloc:\\
            return url\\
\\
        if parsed_url.path.startswith('/cache/files/') and parsed_url.netloc != api_js_url.netloc:\\
            return urllib.parse.urlunparse((api_js_url.scheme, api_js_url.netloc, parsed_url.path, parsed_url.params, parsed_url.query, parsed_url.fragment))\\
    except Exception as e:\\
        logger.warning('rewrite onlyoffice file url failed: %s', e)\\
\\
    return url\\
" "$onlyoffice_views_file"

    sed -i "/url = post_data.get('url')/a\\
        url = _rewrite_onlyoffice_file_url_for_internal_callback(url)\\
" "$onlyoffice_views_file"
  fi

  if [ -f "$onlyoffice_views_file" ]; then
    sed -i "s/        service_url = urllib.parse.urlparse(get_service_url())//g" "$onlyoffice_views_file"
    sed -i "s/        if parsed_url.scheme and parsed_url.netloc == service_url.netloc and parsed_url.path.startswith('\/cache\/files\/'):/        if parsed_url.path.startswith('\/cache\/files\/') and parsed_url.netloc != api_js_url.netloc:/g" "$onlyoffice_views_file"
  fi
}

# The owner's shared outbound email relay (${smtp.*}), projected in as MOS_SMTP_*
# and written into seahub_settings.py as Django email settings. Seahub sends mail
# for password reset, new-user accounts, share-by-email, group invites and
# notifications. Written with Python repr() rather than the sed helper above: a
# relay password may contain quotes or backslashes that would break a
# hand-quoted Python assignment, and repr() escapes them correctly. The block is
# MOS-owned and delimited, so every start rewrites it whole and clearing the
# relay removes it — a stale block must never keep mailing through a relay that
# is gone. Failure here never blocks startup: Seafile without email still runs.
patch_seahub_email_settings() {
  [ -f "$SEAHUB_SETTINGS_FILE" ] || return 0
  command -v python3 >/dev/null 2>&1 || { echo "MOS: python3 unavailable; skipping SMTP settings"; return 0; }
  SEAHUB_SETTINGS_FILE="$SEAHUB_SETTINGS_FILE" python3 - <<'PY' || echo "MOS: SMTP settings patch failed; Seafile email left unconfigured"
import os, re
path = os.environ["SEAHUB_SETTINGS_FILE"]
begin, end = "# >>> MOS SMTP (managed) >>>", "# <<< MOS SMTP (managed) <<<"
try:
    with open(path, encoding="utf-8") as f:
        text = f.read()
except OSError:
    raise SystemExit(0)
text = re.sub(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", "", text, flags=re.S)
host = os.environ.get("MOS_SMTP_HOST", "").strip()
if host:
    def flag(name):
        return "True" if os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on") else "False"
    port = os.environ.get("MOS_SMTP_PORT", "").strip()
    block = "\n".join([
        begin,
        "EMAIL_HOST = %r" % host,
        "EMAIL_PORT = %d" % (int(port) if port.isdigit() else 587),
        "EMAIL_HOST_USER = %r" % os.environ.get("MOS_SMTP_USERNAME", ""),
        "EMAIL_HOST_PASSWORD = %r" % os.environ.get("MOS_SMTP_PASSWORD", ""),
        "DEFAULT_FROM_EMAIL = %r" % os.environ.get("MOS_SMTP_FROM", ""),
        "SERVER_EMAIL = %r" % os.environ.get("MOS_SMTP_FROM", ""),
        "EMAIL_USE_TLS = %s" % flag("MOS_SMTP_START_TLS"),
        "EMAIL_USE_SSL = %s" % flag("MOS_SMTP_IMPLICIT_TLS"),
        end,
        "",
    ])
    text = text.rstrip("\n") + "\n" + block
with open(path, "w", encoding="utf-8") as f:
    f.write(text)
PY
}

patch_seahub_proxy_settings
patch_seafdav_settings
patch_seahub_onlyoffice_settings
patch_seahub_email_settings
patch_seahub_onlyoffice_runtime

(
  i=0
  onlyoffice_utils_file="/opt/seafile/seafile-server-latest/seahub/seahub/onlyoffice/utils.py"
  while [ $i -lt 300 ]; do
    patch_seahub_onlyoffice_runtime
    if [ -f "$SEAHUB_SETTINGS_FILE" ]; then
      patch_seahub_proxy_settings
      patch_seahub_onlyoffice_settings
      patch_seahub_email_settings
    fi
    patch_seafdav_settings
    if [ -f "$SEAHUB_SETTINGS_FILE" ] && [ -f "$onlyoffice_utils_file" ] && grep -q "_get_onlyoffice_internal_seafile_url" "$onlyoffice_utils_file" && [ -f "$SEAFDAV_SETTINGS_FILE" ] && grep -q "^enabled = true" "$SEAFDAV_SETTINGS_FILE"; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
) &

exec /sbin/my_init -- /scripts/enterpoint.sh
