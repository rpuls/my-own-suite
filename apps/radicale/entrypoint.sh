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

cfg = configparser.ConfigParser()
cfg.read(config_path)
if "auth" not in cfg:
    cfg["auth"] = {}

cfg["auth"]["type"] = "htpasswd"
cfg["auth"]["htpasswd_filename"] = users_path
cfg["auth"]["htpasswd_encryption"] = "bcrypt"

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
    with open(props_path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"tag": "VCALENDAR"}))

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
    print(f"Default calendar for '{admin_user}' already exists")
PY

exec /usr/local/bin/docker-entrypoint.sh "$@"
