#!/bin/sh
set -eu

SEAHUB_SETTINGS_FILE="/shared/seafile/conf/seahub_settings.py"

# Railway can run this image on hosts where syslog-ng version differs from
# the config syntax bundled in the image. Normalize the config before my_init.
if [ -f /etc/syslog-ng/syslog-ng.conf ]; then
  sed -i "s/@version: 4.3/@version: 3.35/g" /etc/syslog-ng/syslog-ng.conf || true
  sed -i "s/stats(freq(0));/stats_freq(0);/g" /etc/syslog-ng/syslog-ng.conf || true
fi

append_if_missing() {
  file="$1"
  pattern="$2"
  line="$3"
  if ! grep -q "$pattern" "$file"; then
    echo "$line" >> "$file"
  fi
}

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
    upsert_setting "$SEAHUB_SETTINGS_FILE" "CSRF_TRUSTED_ORIGINS" "CSRF_TRUSTED_ORIGINS = ['https://${SEAFILE_SERVER_HOSTNAME}']"
  fi

  # Railway (and most PaaS ingress) terminates TLS at the proxy.
  # These settings make Django trust forwarded scheme/host so CSRF checks pass.
  upsert_setting "$SEAHUB_SETTINGS_FILE" "SECURE_PROXY_SSL_HEADER" "SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "USE_X_FORWARDED_HOST" "USE_X_FORWARDED_HOST = True"
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

  enable_onlyoffice_py="$(to_python_bool "$enable_onlyoffice")"
  verify_onlyoffice_cert_py="$(to_python_bool "$verify_onlyoffice_cert")"
  onlyoffice_force_save_py="$(to_python_bool "$onlyoffice_force_save")"

  upsert_setting "$SEAHUB_SETTINGS_FILE" "ENABLE_ONLYOFFICE" "ENABLE_ONLYOFFICE = ${enable_onlyoffice_py}"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "VERIFY_ONLYOFFICE_CERTIFICATE" "VERIFY_ONLYOFFICE_CERTIFICATE = ${verify_onlyoffice_cert_py}"

  if is_non_falsy_string "$onlyoffice_apijs_url"; then
    upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_APIJS_URL" "ONLYOFFICE_APIJS_URL = '${onlyoffice_apijs_url}'"
  fi

  upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_FILE_EXTENSION" "ONLYOFFICE_FILE_EXTENSION = ('doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'fodt', 'odp', 'fodp', 'ods', 'fods', 'csv', 'ppsx', 'pps')"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_EDIT_FILE_EXTENSION" "ONLYOFFICE_EDIT_FILE_EXTENSION = ('docx', 'pptx', 'xlsx')"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_FORCE_SAVE" "ONLYOFFICE_FORCE_SAVE = ${onlyoffice_force_save_py}"

  if [ -n "${ONLYOFFICE_JWT_SECRET:-}" ]; then
    upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_JWT_SECRET" "ONLYOFFICE_JWT_SECRET = '${ONLYOFFICE_JWT_SECRET}'"
  fi

  if is_non_falsy_string "$onlyoffice_internal_seafile_url"; then
    upsert_setting "$SEAHUB_SETTINGS_FILE" "ONLYOFFICE_INTERNAL_SEAFILE_URL" "ONLYOFFICE_INTERNAL_SEAFILE_URL = '${onlyoffice_internal_seafile_url}'"
  fi
}

patch_seahub_smtp_settings() {
  if [ ! -f "$SEAHUB_SETTINGS_FILE" ]; then
    return 0
  fi

  to_python_bool() {
    case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in
      1|true|yes|on) echo "True" ;;
      *) echo "False" ;;
    esac
  }

  smtp_enabled="${SMTP_ENABLED:-false}"
  smtp_host="${SMTP_HOST:-}"
  smtp_username="${SMTP_USERNAME:-}"
  smtp_password="${SMTP_PASSWORD:-}"
  smtp_from="${SMTP_FROM:-}"
  smtp_port="${SMTP_PORT:-25}"
  smtp_security="$(echo "${SMTP_SECURITY:-starttls}" | tr '[:upper:]' '[:lower:]')"

  if [ -z "$smtp_from" ] && [ -n "$smtp_username" ]; then
    smtp_from="$smtp_username"
  fi

  if [ "$(to_python_bool "$smtp_enabled")" = "True" ] && [ -n "$smtp_host" ] && [ -n "$smtp_from" ]; then
    case "$smtp_security" in
      force_tls|ssl)
        email_use_tls="False"
        email_use_ssl="True"
        ;;
      none|off)
        email_use_tls="False"
        email_use_ssl="False"
        ;;
      *)
        email_use_tls="True"
        email_use_ssl="False"
        ;;
    esac
  else
    smtp_host=""
    smtp_username=""
    smtp_password=""
    smtp_from=""
    smtp_port="25"
    email_use_tls="False"
    email_use_ssl="False"
  fi

  upsert_setting "$SEAHUB_SETTINGS_FILE" "EMAIL_HOST" "EMAIL_HOST = '${smtp_host}'"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "EMAIL_HOST_USER" "EMAIL_HOST_USER = '${smtp_username}'"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "EMAIL_HOST_PASSWORD" "EMAIL_HOST_PASSWORD = '${smtp_password}'"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "EMAIL_PORT" "EMAIL_PORT = ${smtp_port}"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "EMAIL_USE_TLS" "EMAIL_USE_TLS = ${email_use_tls}"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "EMAIL_USE_SSL" "EMAIL_USE_SSL = ${email_use_ssl}"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "DEFAULT_FROM_EMAIL" "DEFAULT_FROM_EMAIL = '${smtp_from}'"
  upsert_setting "$SEAHUB_SETTINGS_FILE" "SERVER_EMAIL" "SERVER_EMAIL = '${smtp_from}'"
}

patch_seahub_onlyoffice_runtime() {
  onlyoffice_utils_file="/opt/seafile/seafile-server-latest/seahub/seahub/onlyoffice/utils.py"
  onlyoffice_views_file="/opt/seafile/seafile-server-latest/seahub/seahub/onlyoffice/views.py"
  if [ ! -f "$onlyoffice_utils_file" ]; then
    return 0
  fi

  # Idempotent runtime patch: let ONLYOFFICE use an internal Seafile base URL
  # for server-to-server download/callback flows when configured.
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

  # If callback URL uses internal Seafile host, some ONLYOFFICE builds may send
  # status.url back on the same host. Rewrite such cache URLs to ONLYOFFICE host.
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

  # Update older runtime patch variants in-place (idempotent migration).
  if [ -f "$onlyoffice_views_file" ]; then
    sed -i "s/        service_url = urllib.parse.urlparse(get_service_url())//g" "$onlyoffice_views_file"
    sed -i "s/        if parsed_url.scheme and parsed_url.netloc == service_url.netloc and parsed_url.path.startswith('\/cache\/files\/'):/        if parsed_url.path.startswith('\/cache\/files\/') and parsed_url.netloc != api_js_url.netloc:/g" "$onlyoffice_views_file"
  fi
}

# Apply proxy/CSRF settings for existing installs.
patch_seahub_proxy_settings
patch_seahub_onlyoffice_settings
patch_seahub_smtp_settings
patch_seahub_onlyoffice_runtime

# First boot creates seahub_settings.py later. Wait briefly and patch once.
(
  i=0
  onlyoffice_utils_file="/opt/seafile/seafile-server-latest/seahub/seahub/onlyoffice/utils.py"
  while [ $i -lt 300 ]; do
    patch_seahub_onlyoffice_runtime

    if [ -f "$SEAHUB_SETTINGS_FILE" ]; then
      patch_seahub_proxy_settings
      patch_seahub_onlyoffice_settings
      patch_seahub_smtp_settings
    fi

    if [ -f "$SEAHUB_SETTINGS_FILE" ] && [ -f "$onlyoffice_utils_file" ] && grep -q "_get_onlyoffice_internal_seafile_url" "$onlyoffice_utils_file"; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
) &

exec /sbin/my_init -- /scripts/enterpoint.sh
