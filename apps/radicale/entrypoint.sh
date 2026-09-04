#!/bin/sh
set -eu

ADMIN_USER="${RADICALE_ADMIN_USERNAME:-}"
ADMIN_PASS="${RADICALE_ADMIN_PASSWORD:-}"

if [ -z "$ADMIN_USER" ] || [ -z "$ADMIN_PASS" ]; then
  echo "ERROR: Set RADICALE_ADMIN_USERNAME and RADICALE_ADMIN_PASSWORD."
  exit 1
fi

/venv/bin/python - <<'PY'
import configparser
import datetime
import json
import os
import uuid
from passlib.apache import HtpasswdFile

config_path = "/config/config"
users_path = "/data/users"
admin_user = os.environ["RADICALE_ADMIN_USERNAME"]
admin_pass = os.environ["RADICALE_ADMIN_PASSWORD"]
display_name = os.environ.get("RADICALE_CALENDAR_DISPLAYNAME", "").strip() or "My Calendar"

cfg = configparser.ConfigParser()
cfg.read(config_path)
if "auth" not in cfg:
    cfg["auth"] = {}

cfg["auth"]["type"] = "htpasswd"
cfg["auth"]["htpasswd_filename"] = users_path
cfg["auth"]["htpasswd_encryption"] = "bcrypt"

# The owner's shared outbound email relay (${smtp.*}), projected in as MOS_SMTP_*.
# Radicale's only email is the [hook] "email" type: when a calendar object with
# ATTENDEEs changes, it emails those attendees an iMIP notification. The whole
# section is owned by MOS and driven purely from env, so it is fully rewritten on
# every start and removed again the moment the owner clears the relay — a stale
# hook must never keep trying to send through a relay that is gone.
smtp_host = os.environ.get("MOS_SMTP_HOST", "").strip()
if smtp_host:
    hook = {"type": "email", "smtp_server": smtp_host}
    port = os.environ.get("MOS_SMTP_PORT", "").strip()
    if port:
        hook["smtp_port"] = port
    hook["smtp_security"] = os.environ.get("MOS_SMTP_SECURITY", "").strip() or "starttls"
    smtp_user = os.environ.get("MOS_SMTP_USERNAME", "").strip()
    if smtp_user:
        hook["smtp_username"] = smtp_user
        hook["smtp_password"] = os.environ.get("MOS_SMTP_PASSWORD", "")
    from_email = os.environ.get("MOS_SMTP_FROM", "").strip()
    if from_email:
        hook["from_email"] = from_email
    allow_invalid = os.environ.get("MOS_SMTP_ALLOW_INVALID_CERT", "").strip().lower() in ("1", "true", "yes", "on")
    hook["smtp_ssl_verify_mode"] = "NONE" if allow_invalid else "REQUIRED"
    cfg["hook"] = hook
elif "hook" in cfg and cfg["hook"].get("type") == "email":
    del cfg["hook"]

with open(config_path, "w", encoding="utf-8") as f:
    cfg.write(f)

ht = HtpasswdFile(users_path, new=not os.path.exists(users_path), default_scheme="bcrypt")
if admin_user not in ht.users():
    ht.set_password(admin_user, admin_pass)
    ht.save()
    print(f"Created Radicale admin user '{admin_user}'")
else:
    print(f"Radicale admin user '{admin_user}' already exists")

calendar_dir = f"/data/collections/collection-root/{admin_user}/default-calendar"
props_path = os.path.join(calendar_dir, ".Radicale.props")
os.makedirs(calendar_dir, exist_ok=True)
if not os.path.exists(props_path):
    # The display name is what clients show; without it, phones fall back to
    # the ugly URL slug "default-calendar" — which tempts owners into deleting
    # the calendar and recreating it under a new path, silently breaking the
    # dashboard widget that exports this exact collection.
    with open(props_path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"D:displayname": display_name, "tag": "VCALENDAR"}))

    # One all-day event on install day, repeating yearly. A calendar with no
    # items at all exports a valid but empty VCALENDAR, and the Homepage
    # calendar widget reports an empty feed as a red error, so a brand-new
    # Radicale would look broken on the dashboard until the owner happened to
    # add something. It repeats rather than sitting on a single date so the
    # calendar is never empty again, and it doubles as proof that sync reached
    # the client. Nothing here invites deleting it: an owner who removes every
    # event is back to an empty feed and the upstream error with it.
    today = datetime.date.today()
    event = "\r\n".join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//My Own Suite//Radicale package//EN",
        "BEGIN:VEVENT",
        f"UID:{uuid.uuid4()}",
        f"DTSTAMP:{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        f"DTSTART;VALUE=DATE:{today.strftime('%Y%m%d')}",
        f"DTEND;VALUE=DATE:{(today + datetime.timedelta(days=1)).strftime('%Y%m%d')}",
        "RRULE:FREQ=YEARLY",
        "SUMMARY:Your independence day",
        "DESCRIPTION:The day your calendar moved to a server you own. "
        "This calendar syncs from your own hardware - no one else holds a copy.",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
    ])
    with open(os.path.join(calendar_dir, "mos-welcome.ics"), "w", encoding="utf-8") as f:
        f.write(event)
    print(f"Created default calendar for '{admin_user}'")
else:
    # Calendars seeded before the display name existed show the URL slug in
    # clients. Name them once; a calendar the owner already renamed carries a
    # displayname of its own and is left alone.
    props = None
    try:
        with open(props_path, encoding="utf-8") as f:
            props = json.load(f)
    except (OSError, ValueError):
        pass
    if isinstance(props, dict) and "D:displayname" not in props:
        props["D:displayname"] = display_name
        with open(props_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(props))
    print(f"Default calendar for '{admin_user}' already exists")
PY

exec /usr/local/bin/docker-entrypoint.sh "$@"
