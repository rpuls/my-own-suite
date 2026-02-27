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
from datetime import datetime, timedelta, timezone
import json
import os
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

# Ensure a default calendar exists for iCal widget integration.
calendar_dir = f"/data/collections/collection-root/{admin_user}/default-calendar"
props_path = os.path.join(calendar_dir, ".Radicale.props")
os.makedirs(calendar_dir, exist_ok=True)
if not os.path.exists(props_path):
    with open(props_path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"tag": "VCALENDAR"}))
    print(f"Created default calendar for '{admin_user}'")
else:
    print(f"Default calendar for '{admin_user}' already exists")

# Seed one launch-day event for first-run visibility in Homepage calendar widget.
launch_event_path = os.path.join(calendar_dir, "my-independence-day.ics")
if not os.path.exists(launch_event_path):
    launch_day = datetime.now(timezone.utc).date()
    launch_day_end = launch_day + timedelta(days=1)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    launch_event = "\n".join(
        [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//My-Own-Suite//Radicale Bootstrap//EN",
            "BEGIN:VEVENT",
            "UID:my-independence-day@my-own-suite",
            f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{launch_day.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{launch_day_end.strftime('%Y%m%d')}",
            "SUMMARY:My Independence day",
            "DESCRIPTION:Launch day of my self-hosted stack.",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ]
    )
    with open(launch_event_path, "w", encoding="utf-8") as f:
        f.write(launch_event)
    print(f"Created launch event for '{admin_user}'")
else:
    print(f"Launch event for '{admin_user}' already exists")
PY

exec /usr/local/bin/docker-entrypoint.sh "$@"
