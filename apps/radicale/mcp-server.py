"""The tools MOS offers an owner's AI for Radicale, as a small MCP server.

Only MOS calls it, with the key MOS generated for this package. It acts as the
Radicale user MOS set up, and reaches nothing but Radicale's CalDAV and CardDAV.
"""

import base64
import datetime
import hmac
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SERVER = os.environ.get("RADICALE_URL", "http://radicale:5232").rstrip("/")
USERNAME = os.environ.get("RADICALE_ADMIN_USERNAME", "")
PASSWORD = os.environ.get("RADICALE_ADMIN_PASSWORD", "")
MOS_KEY = os.environ.get("MOS_AI_KEY", "")
PORT = int(os.environ.get("PORT", "8100"))

PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"]
BODY_LIMIT = 1_000_000
EVENT_LIMIT = 50
CONTACT_LIMIT = 20
RANGE_LIMIT_DAYS = 366
ZONE_TTL = 600
# The calendar the package seeds and the dashboard widget reads.
DEFAULT_CALENDAR = "default-calendar"
UTC = ZoneInfo("UTC")
DAV, CALDAV, CARDDAV = "{DAV:}", "{urn:ietf:params:xml:ns:caldav}", "{urn:ietf:params:xml:ns:carddav}"

PROPFIND_COLLECTIONS = """<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop>
<D:resourcetype/><D:displayname/><C:supported-calendar-component-set/><C:calendar-timezone/>
</D:prop></D:propfind>"""

EVENT_QUERY = """<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
<D:prop><C:calendar-data>{expand}</C:calendar-data></D:prop>
<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">
<C:time-range start="{start}" end="{end}"/></C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>"""

CONTACT_QUERY = """<?xml version="1.0" encoding="utf-8"?>
<CR:addressbook-query xmlns:D="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav">
<D:prop><CR:address-data/></D:prop></CR:addressbook-query>"""


class ToolError(Exception):
    pass


def text(value):
    return str(value or "").strip()


def stamp(moment):
    return moment.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


class Radicale:
    def __init__(self):
        self.auth = "Basic " + base64.b64encode(f"{USERNAME}:{PASSWORD}".encode()).decode()
        self.home = f"/{urllib.parse.quote(USERNAME, safe='')}/"
        self.zone = None

    def send(self, method, path, body=None, headers=None):
        request = urllib.request.Request(f"{SERVER}{path}", data=body, method=method)
        request.add_header("Authorization", self.auth)
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                return response.read().decode("utf-8", "replace"), response.headers.get("ETag")
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise ToolError(
                    "Radicale did not accept the sign-in MOS set up. If the Radicale password was "
                    "changed outside MOS, MOS can no longer reach your calendars."
                ) from None
            if error.code == 404:
                raise ToolError("Radicale has no calendar or event at that id. list_events shows the ids it has.") from None
            if error.code == 412:
                raise ToolError("That event changed in the meantime. Look it up again with list_events and retry.") from None
            detail = error.read().decode("utf-8", "replace")[:300]
            raise ToolError(f"Radicale refused that (HTTP {error.code}): {detail}") from None
        except urllib.error.URLError:
            raise ToolError("Radicale is not answering right now. Try again in a minute.") from None

    def multistatus(self, method, path, body):
        answer, _ = self.send(method, path, body.encode(), {"Content-Type": "application/xml; charset=utf-8", "Depth": "1"})
        found = []
        for response in ET.fromstring(answer).iter(f"{DAV}response"):
            props = {}
            for propstat in response.iter(f"{DAV}propstat"):
                held = propstat.find(f"{DAV}prop")
                if " 200 " in (propstat.findtext(f"{DAV}status") or "") and held is not None:
                    props.update((prop.tag, prop) for prop in held)
            found.append((urllib.parse.unquote(response.findtext(f"{DAV}href") or ""), props))
        return found

    def collections(self):
        found = []
        for href, props in self.multistatus("PROPFIND", self.home, PROPFIND_COLLECTIONS):
            kinds = props.get(f"{DAV}resourcetype")
            types = {child.tag for child in kinds} if kinds is not None else set()
            slug = href.rstrip("/").rsplit("/", 1)[-1]
            name = text(props[f"{DAV}displayname"].text) if f"{DAV}displayname" in props else ""
            supported = props.get(f"{CALDAV}supported-calendar-component-set")
            components = {comp.get("name") for comp in supported.iter(f"{CALDAV}comp")} if supported is not None else set()
            zone = props.get(f"{CALDAV}calendar-timezone")
            if f"{CALDAV}calendar" in types:
                found.append({"components": components or {"VEVENT"}, "id": slug, "kind": "calendar", "name": name or slug, "zone": text(zone.text) if zone is not None else ""})
            elif f"{CARDDAV}addressbook" in types:
                found.append({"id": slug, "kind": "addressbook", "name": name or slug})
        return sorted(found, key=lambda item: (item["id"] != DEFAULT_CALENDAR, item["name"].casefold()))

    def path_of(self, collection, item=""):
        return f"{self.home}{urllib.parse.quote(collection, safe='')}/{urllib.parse.quote(item, safe='')}"

    def events_between(self, calendar, start, end, expand=True):
        window = {"end": stamp(end), "start": stamp(start)}
        query = EVENT_QUERY.format(expand='<C:expand start="{start}" end="{end}"/>'.format(**window) if expand else "", **window)
        found = self.multistatus("REPORT", self.path_of(calendar["id"]), query)
        return [(href.rsplit("/", 1)[-1], props[f"{CALDAV}calendar-data"].text or "") for href, props in found if f"{CALDAV}calendar-data" in props]

    def contacts(self, addressbook):
        found = self.multistatus("REPORT", self.path_of(addressbook["id"]), CONTACT_QUERY)
        return [props[f"{CARDDAV}address-data"].text or "" for _, props in found if f"{CARDDAV}address-data" in props]

    # The zone the owner's own clients write events in, relearned every ten minutes; None until one has.
    def owner_zone(self, calendars):
        if self.zone and time.monotonic() - self.zone[0] < ZONE_TTL:
            return self.zone[1]
        zone = next((found for found in (zone_of_vtimezone(calendar["zone"]) for calendar in calendars) if found), None)
        if not zone:
            now = datetime.datetime.now(UTC)
            seen = Counter()
            for calendar in calendars:
                for _, data in self.events_between(calendar, now - datetime.timedelta(days=365), now + datetime.timedelta(days=365), expand=False):
                    for event in walk(parse_ical(data), "VEVENT"):
                        params, _ = first(event, "DTSTART")
                        found = zone_named((params or {}).get("TZID"))
                        if found:
                            seen[found.key] += 1
            zone = ZoneInfo(seen.most_common(1)[0][0]) if seen else None
        self.zone = (time.monotonic(), zone)
        return zone


radicale = Radicale()


def unfold(data):
    return re.sub(r"\r?\n[ \t]", "", data or "").splitlines()


def split_property(line):
    quoted = False
    for index, char in enumerate(line):
        if char == '"':
            quoted = not quoted
        elif char == ":" and not quoted:
            name, *params = re.findall(r'(?:[^;"]|"[^"]*")+', line[:index]) or [""]
            pairs = (param.partition("=") for param in params)
            return name.upper(), {key.upper(): value.strip('"') for key, _, value in pairs}, line[index + 1:]
    return None


def parse_ical(data):
    root = {"children": [], "name": None, "props": []}
    stack = [root]
    for line in unfold(data):
        parsed = split_property(line)
        if not parsed:
            continue
        name, params, value = parsed
        if name == "BEGIN":
            child = {"children": [], "name": value.strip().upper(), "props": []}
            stack[-1]["children"].append(child)
            stack.append(child)
        elif name == "END":
            if len(stack) > 1:
                stack.pop()
        else:
            stack[-1]["props"].append((name, params, value))
    return root


def walk(component, name):
    for child in component["children"]:
        if child["name"] == name:
            yield child
        yield from walk(child, name)


def first(component, name):
    return next(((params, value) for prop, params, value in component["props"] if prop == name), (None, None))


def all_of(component, name):
    return [value for prop, _, value in component["props"] if prop == name]


def unescape(value):
    return re.sub(r"\\(.)", lambda match: "\n" if match.group(1) in "nN" else match.group(1), value or "").strip()


def escape(value):
    return value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\n").replace("\n", "\\n")


def fold(line):
    pieces, piece, size = [], "", 0
    for char in line:
        width = len(char.encode())
        if size + width > 75:
            pieces.append(piece)
            piece, size = " ", 1
        piece += char
        size += width
    return "\r\n".join(pieces + [piece])


def zone_named(name):
    # Some clients prefix the zone name with a vendor path, such as /mozilla.org/20050126_1/Europe/Amsterdam.
    parts = text(name).strip('"').split("/")
    for start in range(len(parts)):
        try:
            return ZoneInfo("/".join(parts[start:]))
        except (ZoneInfoNotFoundError, ValueError):
            continue
    return None


def zone_of_vtimezone(data):
    for zone in walk(parse_ical(data), "VTIMEZONE"):
        found = zone_named(first(zone, "TZID")[1])
        if found:
            return found
    return None


def asked_zone(args, calendars):
    """The zone to read and show times in, and how to name it to the assistant."""
    name = text(args.get("time_zone"))
    if not name:
        zone = radicale.owner_zone(calendars)
        return (zone, zone.key) if zone else (UTC, "UTC, as no event shows the owner's time zone yet")
    try:
        zone = ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ToolError(f'"{name}" is not a time zone name. Use one such as Europe/Amsterdam.') from None
    return zone, zone.key


def read_time(params, value, zone):
    value = text(value)
    if (params or {}).get("VALUE") == "DATE" or len(value) == 8:
        return datetime.date(int(value[:4]), int(value[4:6]), int(value[6:8]))
    moment = datetime.datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
    if value.endswith("Z"):
        return moment.replace(tzinfo=UTC)
    return moment.replace(tzinfo=zone_named((params or {}).get("TZID")) or zone)


def read_duration(value):
    match = re.fullmatch(r"([-+])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", text(value))
    if not match:
        return None
    weeks, days, hours, minutes, seconds = (int(part or 0) for part in match.groups()[1:])
    length = datetime.timedelta(weeks=weeks, days=days, hours=hours, minutes=minutes, seconds=seconds)
    return -length if match.group(1) == "-" else length


def event_of(component, zone):
    start = read_time(*first(component, "DTSTART"), zone)
    all_day = not isinstance(start, datetime.datetime)
    end_params, end_value = first(component, "DTEND")
    if end_value:
        end = read_time(end_params, end_value, zone)
    else:
        end = start + (read_duration(first(component, "DURATION")[1]) or datetime.timedelta(days=1 if all_day else 0))
    if all_day and isinstance(end, datetime.datetime):
        end = end.date()
    elif not all_day and not isinstance(end, datetime.datetime):
        end = start
    return {
        "all_day": all_day,
        "description": unescape(first(component, "DESCRIPTION")[1]),
        "end": max(end, start),
        "invited": len(all_of(component, "ATTENDEE")),
        "location": unescape(first(component, "LOCATION")[1]),
        "repeats": bool(first(component, "RECURRENCE-ID")[1] or first(component, "RRULE")[1]),
        "start": start,
        "title": unescape(first(component, "SUMMARY")[1]) or "(no title)",
    }


def local_start(event, zone):
    if event["all_day"]:
        return datetime.datetime.combine(event["start"], datetime.time(), zone)
    return event["start"].astimezone(zone)


def overlaps(event, start, end):
    if event["all_day"]:
        last = event["end"] if event["end"] > event["start"] else event["start"] + datetime.timedelta(days=1)
        return event["start"] < end.date() and last > start.date()
    return event["start"] < end and (event["end"] > start or event["end"] == event["start"] >= start)


def describe_when(event, zone):
    if event["all_day"]:
        last = max(event["start"], event["end"] - datetime.timedelta(days=1))
        span = f'{event["start"]:%a %Y-%m-%d}' + (f" to {last:%a %Y-%m-%d}" if last > event["start"] else "")
        return f"{span} · all day"
    start, end = event["start"].astimezone(zone), event["end"].astimezone(zone)
    if end == start:
        return f"{start:%a %Y-%m-%d %H:%M}"
    if end.date() == start.date():
        return f"{start:%a %Y-%m-%d %H:%M}-{end:%H:%M}"
    return f"{start:%a %Y-%m-%d %H:%M} to {end:%a %Y-%m-%d %H:%M}"


def describe(event, event_id, zone, calendar_name=None):
    parts = [describe_when(event, zone), event["title"]]
    if calendar_name:
        parts.append(f"in {calendar_name}")
    if event["repeats"]:
        parts.append("repeats")
    if event["invited"]:
        parts.append(f'{event["invited"]} invited')
    lines = [" · ".join(parts + [f"id {event_id}"])]
    if event["location"]:
        lines.append(f'  at {event["location"]}')
    if event["description"]:
        summary = re.sub(r"\s+", " ", event["description"])
        lines.append(f"  {summary[:200]}{'…' if len(summary) > 200 else ''}")
    return "\n".join(lines)


def calendars_for(name):
    calendars = [found for found in radicale.collections() if found["kind"] == "calendar" and "VEVENT" in found["components"]]
    if not calendars:
        raise ToolError("Radicale has no calendar that holds events.")
    wanted = text(name).casefold()
    if not wanted:
        return calendars, calendars
    chosen = [found for found in calendars if wanted in (found["id"].casefold(), found["name"].casefold())]
    if not chosen:
        names = ", ".join(f'{found["name"]} ({found["id"]})' for found in calendars)
        raise ToolError(f'There is no calendar called "{text(name)}". The calendars are: {names}.')
    return chosen, calendars


def default_calendar(calendars):
    return next((found for found in calendars if found["id"] == DEFAULT_CALENDAR), calendars[0])


def read_day(value, label):
    value = text(value)
    if not value:
        return None
    try:
        return datetime.date.fromisoformat(value[:10])
    except ValueError:
        raise ToolError(f"Give {label} as YYYY-MM-DD.") from None


def read_moment(value, label, zone):
    value = text(value)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return datetime.date.fromisoformat(value)
    try:
        moment = datetime.datetime.fromisoformat(value.replace(" ", "T", 1))
    except ValueError:
        raise ToolError(f'Give {label} as "YYYY-MM-DD HH:MM", or as YYYY-MM-DD for an all-day event.') from None
    if moment.tzinfo:
        return moment
    placed = moment.replace(tzinfo=zone)
    if placed.astimezone(UTC).astimezone(zone).replace(tzinfo=None) != moment:
        raise ToolError(f"{moment:%H:%M} does not exist on {moment:%Y-%m-%d} in {zone.key}: the clocks skip it. Pick another time.")
    return placed


def write_time(name, moment):
    if isinstance(moment, datetime.datetime):
        return f"{name}:{stamp(moment)}"
    return f"{name};VALUE=DATE:{moment:%Y%m%d}"


def event_span(start, end):
    """The start and exclusive end to store, from what the assistant gave."""
    if isinstance(start, datetime.datetime):
        if end is None:
            return start, (start.astimezone(UTC) + datetime.timedelta(hours=1)).astimezone(start.tzinfo)
        if not isinstance(end, datetime.datetime):
            raise ToolError('This event has a time, so give its end as "YYYY-MM-DD HH:MM" too.')
        if end < start:
            raise ToolError("The end is before the start.")
        return start, end
    if end is None:
        return start, start + datetime.timedelta(days=1)
    if isinstance(end, datetime.datetime):
        raise ToolError("An all-day event ends on a day: give its last day as YYYY-MM-DD.")
    if end < start:
        raise ToolError("The last day is before the first.")
    return start, end + datetime.timedelta(days=1)


def list_calendars(_args):
    found = radicale.collections()
    calendars = [item for item in found if item["kind"] == "calendar"]
    event_calendars = [item for item in calendars if "VEVENT" in item["components"]]
    books = [item for item in found if item["kind"] == "addressbook"]
    lines = ["Calendars:" if calendars else "No calendars yet."]
    for item in calendars:
        notes = []
        if "VEVENT" not in item["components"]:
            notes.append("tasks only")
        if event_calendars and item is default_calendar(event_calendars):
            notes.append("new events go here unless you name another")
        lines.append(f'- {item["name"]} (id {item["id"]})' + (f' · {", ".join(notes)}' if notes else ""))
    lines.append("Address books:" if books else "No address books yet.")
    lines.extend(f'- {item["name"]} (id {item["id"]})' for item in books)
    if event_calendars:
        lines.append(f"Times are in {asked_zone({}, event_calendars)[1]}. Pass time_zone to use another.")
    return "\n".join(lines)


def list_events(args):
    chosen, calendars = calendars_for(args.get("calendar"))
    zone, zone_name = asked_zone(args, calendars)
    first_day = read_day(args.get("start"), "start") or datetime.datetime.now(zone).date()
    last_day = read_day(args.get("end"), "end") or first_day + datetime.timedelta(days=6)
    if last_day < first_day:
        raise ToolError("The end is before the start.")
    if (last_day - first_day).days >= RANGE_LIMIT_DAYS:
        raise ToolError(f"Ask for at most {RANGE_LIMIT_DAYS} days at a time.")
    start = datetime.datetime.combine(first_day, datetime.time(), zone)
    end = datetime.datetime.combine(last_day + datetime.timedelta(days=1), datetime.time(), zone)
    words = text(args.get("query")).casefold().split()

    found = []
    for calendar in chosen:
        for file_name, data in radicale.events_between(calendar, start, end):
            for component in walk(parse_ical(data), "VEVENT"):
                try:
                    event = event_of(component, zone)
                except ValueError:
                    continue
                haystack = " ".join((event["title"], event["location"], event["description"])).casefold()
                if overlaps(event, start, end) and all(word in haystack for word in words):
                    found.append((local_start(event, zone), event, f'{calendar["id"]}/{file_name}', calendar["name"] if len(chosen) > 1 else None))
    span = f"{first_day:%a %Y-%m-%d} to {last_day:%a %Y-%m-%d}"
    if not found:
        return f"No events {'match' if words else 'on the calendar'} from {span} (times in {zone_name})."
    found.sort(key=lambda item: item[0])
    lines = [f'{len(found)} {"event" if len(found) == 1 else "events"} from {span}, times in {zone_name}:']
    lines.extend(describe(event, event_id, zone, calendar_name) for _, event, event_id, calendar_name in found[:EVENT_LIMIT])
    if len(found) > EVENT_LIMIT:
        lines.append(f"Showing the first {EVENT_LIMIT}. Ask for a shorter range to see the rest.")
    return "\n".join(lines)


def contact_of(data):
    card = next(walk(parse_ical(data), "VCARD"), None)
    if not card:
        return None
    name = unescape(first(card, "FN")[1]) or " ".join(part for part in reversed(unescape(first(card, "N")[1]).split(";")[:2]) if part)
    addresses = [", ".join(part.strip() for part in re.split(r"(?<!\\);", value) if part.strip()) for value in all_of(card, "ADR")]
    birthday = text(first(card, "BDAY")[1])
    if re.fullmatch(r"\d{8}", birthday):
        birthday = f"{birthday[:4]}-{birthday[4:6]}-{birthday[6:]}"
    return {
        "addresses": [unescape(address) for address in addresses if address],
        "birthday": birthday,
        "emails": [text(value) for value in all_of(card, "EMAIL") if text(value)],
        "name": name or "(no name)",
        "nickname": unescape(first(card, "NICKNAME")[1]),
        "organisation": unescape(text(first(card, "ORG")[1]).replace(";", " ")),
        "phones": [text(value) for value in all_of(card, "TEL") if text(value)],
    }


def contact_matches(contact, words):
    fields = [contact["name"], contact["nickname"], contact["organisation"], *contact["emails"], *contact["phones"], *contact["addresses"]]
    haystack = " ".join(fields).casefold()
    if all(word in haystack for word in words):
        return True
    digits = re.sub(r"\D", "", " ".join(words))
    return len(digits) >= 3 and any(digits in re.sub(r"\D", "", phone) for phone in contact["phones"])


def search_contacts(args):
    words = text(args.get("query")).casefold().split()
    limit = max(1, min(int(args.get("limit") or 10), CONTACT_LIMIT))
    books = [item for item in radicale.collections() if item["kind"] == "addressbook"]
    if not books:
        return "Radicale has no address book yet."
    contacts = [contact for book in books for contact in map(contact_of, radicale.contacts(book)) if contact]
    found = sorted((contact for contact in contacts if contact_matches(contact, words)), key=lambda contact: contact["name"].casefold())
    if not found:
        return "No contacts match."
    lines = [f'{len(found)} {"contact matches" if len(found) == 1 else "contacts match"}' + (f", showing {limit}:" if len(found) > limit else ":")]
    for contact in found[:limit]:
        parts = [contact["name"], *contact["emails"], *contact["phones"]]
        if contact["organisation"]:
            parts.append(contact["organisation"])
        if contact["birthday"]:
            parts.append(f'born {contact["birthday"]}')
        lines.append(" · ".join(parts))
        lines.extend(f"  {address}" for address in contact["addresses"])
    return "\n".join(lines)


def add_event(args):
    title = text(args.get("title"))[:200]
    if not title:
        raise ToolError("Give the event a title.")
    chosen, calendars = calendars_for(args.get("calendar"))
    calendar = chosen[0] if text(args.get("calendar")) else default_calendar(calendars)
    zone, zone_name = asked_zone(args, calendars)
    start = read_moment(args.get("start"), "start", zone)
    end = read_moment(args.get("end"), "end", zone) if text(args.get("end")) else None
    start, end = event_span(start, end)

    uid = str(uuid.uuid4())
    now = stamp(datetime.datetime.now(UTC))
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//My Own Suite//Radicale AI tools//EN", "BEGIN:VEVENT",
             f"UID:{uid}", f"DTSTAMP:{now}", f"CREATED:{now}", f"LAST-MODIFIED:{now}",
             write_time("DTSTART", start), write_time("DTEND", end), f"SUMMARY:{escape(title)}"]
    for name, limit in (("LOCATION", 200), ("DESCRIPTION", 2000)):
        if text(args.get(name.lower())):
            lines.append(f"{name}:{escape(text(args[name.lower()])[:limit])}")
    lines += ["END:VEVENT", "END:VCALENDAR", ""]
    body = "\r\n".join(fold(line) for line in lines).encode()
    file_name = f"{uid}.ics"
    radicale.send("PUT", radicale.path_of(calendar["id"], file_name), body, {"Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*"})
    event = {"all_day": not isinstance(start, datetime.datetime), "description": "", "end": end, "invited": 0, "location": "", "repeats": False, "start": start, "title": title}
    event_id = f'{calendar["id"]}/{file_name}'
    return f'Added to {calendar["name"]}, times in {zone_name}: {describe(event, event_id, zone)}'


def parse_event_id(value):
    calendar, _, file_name = text(value).partition("/")
    if not calendar or not re.fullmatch(r"[^/\\]+", file_name or "") or file_name.startswith("."):
        raise ToolError("Give the event id exactly as list_events shows it, such as default-calendar/1234.ics.")
    return calendar, file_name


REWRITTEN = ("DTSTART", "DTEND", "DURATION", "SUMMARY", "SEQUENCE", "DTSTAMP", "LAST-MODIFIED")


# Everything but the rewritten properties stays as the owner's client wrote it.
def rewrite_event(data, start, end, title, sequence):
    lines, inside, now = [], False, stamp(datetime.datetime.now(UTC))
    for line in unfold(data):
        parsed = split_property(line)
        name, value = (parsed[0], text(parsed[2]).upper()) if parsed else ("", "")
        if name == "BEGIN" and value == "VEVENT":
            inside = True
        elif name == "END" and value == "VEVENT" and inside:
            lines += [write_time("DTSTART", start), write_time("DTEND", end), *([f"SUMMARY:{escape(title)}"] if title else []),
                      f"SEQUENCE:{sequence}", f"DTSTAMP:{now}", f"LAST-MODIFIED:{now}"]
            inside = False
        elif inside and name in REWRITTEN:
            continue
        lines.append(line)
    return ("\r\n".join(fold(line) for line in lines) + "\r\n").encode()


def change_event(args):
    calendar_id, file_name = parse_event_id(args.get("event_id"))
    calendars = [found for found in radicale.collections() if found["kind"] == "calendar"]
    calendar = next((found for found in calendars if found["id"] == calendar_id), None)
    if not calendar:
        raise ToolError(f'There is no calendar with the id "{calendar_id}". list_calendars shows the ids.')
    path = radicale.path_of(calendar_id, file_name)
    data, etag = radicale.send("GET", path)
    events = list(walk(parse_ical(data), "VEVENT"))
    if not events:
        raise ToolError("That id is not an event.")
    if len(events) > 1 or any(first(events[0], prop)[1] for prop in ("RRULE", "RDATE", "RECURRENCE-ID")):
        raise ToolError("This event repeats. These tools change only single events, so change it in your calendar app.")
    if all_of(events[0], "ATTENDEE"):
        raise ToolError("Other people are invited to this event, and changing it would notify them. Change it in your calendar app instead.")

    zone, zone_name = asked_zone(args, [found for found in calendars if "VEVENT" in found["components"]])
    current = event_of(events[0], zone)
    title = text(args.get("title"))[:200] or unescape(first(events[0], "SUMMARY")[1])
    asked_start, asked_end = text(args.get("start")), text(args.get("end"))
    if not (text(args.get("title")) or asked_start or asked_end):
        raise ToolError("Say what to change: title, start or end.")
    start = read_moment(asked_start, "start", zone) if asked_start else current["start"]
    if isinstance(start, datetime.datetime) != (not current["all_day"]):
        raise ToolError("Give the new start the way the event has it: a day for an all-day event, a day and a time otherwise.")
    if asked_end:
        start, end = event_span(start, read_moment(asked_end, "end", zone))
    else:
        end = start + (current["end"] - current["start"])

    sequence = max([int(value) for value in all_of(events[0], "SEQUENCE") if text(value).isdigit()] or [0]) + 1
    headers = {"Content-Type": "text/calendar; charset=utf-8"}
    if etag:
        headers["If-Match"] = etag
    radicale.send("PUT", path, rewrite_event(data, start, end, title, sequence), headers)
    changed = {**current, "end": end, "start": start, "title": title or current["title"]}
    return f"Changed, times in {zone_name}. Now: {describe(changed, f'{calendar_id}/{file_name}', zone)}"


TIME_ZONE = {"type": "string", "description": "The owner's IANA time zone, such as Europe/Amsterdam, if you know it. Unless set, the zone the owner's events are written in."}
CALENDAR = {"type": "string", "description": "A calendar's name or id, as list_calendars shows it."}

TOOLS = {
    "list_calendars": (list_calendars, {
        "description": "List the owner's calendars and address books, and the time zone the other tools show times in.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True},
    }),
    "list_events": (list_events, {
        "description": "List the events between two days, repeating events included, earliest first. Shows each event's id for change_event.",
        "inputSchema": {"type": "object", "properties": {
            "start": {"type": "string", "description": "The first day, as YYYY-MM-DD. Today unless set."},
            "end": {"type": "string", "description": "The last day, as YYYY-MM-DD. A week after the start unless set."},
            "query": {"type": "string", "description": "Only events whose title, place or description contain these words."},
            "calendar": {**CALENDAR, "description": "Only this calendar's events. Every calendar unless set."},
            "time_zone": TIME_ZONE,
        }},
        "annotations": {"readOnlyHint": True},
    }),
    "search_contacts": (search_contacts, {
        "description": "Find people in the owner's address books by name, email, phone number or organisation.",
        "inputSchema": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Words or digits to look for. Lists everyone when empty."},
            "limit": {"type": "integer", "minimum": 1, "maximum": CONTACT_LIMIT, "description": "How many to show, 10 unless set."},
        }},
        "annotations": {"readOnlyHint": True},
    }),
    "add_event": (add_event, {
        "description": "Add an event to the owner's calendar. It invites no one. Give a day without a time for an all-day event.",
        "inputSchema": {"type": "object", "required": ["title", "start"], "properties": {
            "title": {"type": "string", "maxLength": 200},
            "start": {"type": "string", "description": 'When it starts, as "YYYY-MM-DD HH:MM", or YYYY-MM-DD for an all-day event.'},
            "end": {"type": "string", "description": "When it ends, the same way. An hour after the start, or the same day for an all-day event, unless set. For an all-day event, its last day."},
            "location": {"type": "string", "maxLength": 200},
            "description": {"type": "string", "maxLength": 2000},
            "calendar": {**CALENDAR, "description": "The calendar to add it to. The owner's main calendar unless set."},
            "time_zone": TIME_ZONE,
        }},
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    }),
    "change_event": (change_event, {
        "description": "Move or rename one event that does not repeat and has no one else invited. Only the fields given change; moving the start alone keeps its length.",
        "inputSchema": {"type": "object", "required": ["event_id"], "properties": {
            "event_id": {"type": "string", "description": "The event's id, as list_events shows it."},
            "title": {"type": "string", "maxLength": 200},
            "start": {"type": "string", "description": 'The new start, as "YYYY-MM-DD HH:MM", or YYYY-MM-DD for an all-day event.'},
            "end": {"type": "string", "description": "The new end, the same way. For an all-day event, its last day."},
            "time_zone": TIME_ZONE,
        }},
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True},
    }),
}


def tool_list():
    return [{"name": name, "title": name.replace("_", " ").capitalize(), **spec} for name, (_, spec) in TOOLS.items()]


def call_tool(params):
    name = params.get("name")
    if name not in TOOLS:
        return {"content": [{"type": "text", "text": f"Unknown tool {str(name)[:64]}."}], "isError": True}
    try:
        answer = TOOLS[name][0](params.get("arguments") or {})
        return {"content": [{"type": "text", "text": answer}], "isError": False}
    except ToolError as error:
        return {"content": [{"type": "text", "text": str(error)}], "isError": True}
    except (KeyError, TypeError, ValueError):
        return {"content": [{"type": "text", "text": "Those arguments do not fit this tool. Check the dates and the field names."}], "isError": True}


def answer(message):
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        return {
            "capabilities": {"tools": {}},
            "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
            "serverInfo": {"name": "mos-radicale", "version": "1"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": tool_list()}
    if method == "tools/call":
        return call_tool(params)
    raise LookupError(method)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorised(self):
        presented = self.headers.get("Authorization", "")
        return bool(MOS_KEY) and hmac.compare_digest(presented.encode(), f"Bearer {MOS_KEY}".encode())

    def do_GET(self):
        self.reply(405, {"error": "Send MCP messages with POST."})

    def do_POST(self):
        if self.path.split("?")[0] != "/mcp":
            return self.reply(404, {"error": "Not found."})
        if not self.authorised():
            return self.reply(401, {"error": "Only My Own Suite may call this server."})
        length = int(self.headers.get("Content-Length") or 0)
        if length > BODY_LIMIT:
            return self.reply(413, {"error": "Too large."})
        try:
            message = json.loads(self.rfile.read(length) or b"null")
        except ValueError:
            return self.reply(400, {"error": {"code": -32700, "message": "Not JSON."}, "id": None, "jsonrpc": "2.0"})
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return self.reply(400, {"error": {"code": -32600, "message": "Not a JSON-RPC 2.0 request."}, "id": None, "jsonrpc": "2.0"})
        if message.get("id") is None:
            return self.reply(202)
        try:
            return self.reply(200, {"id": message["id"], "jsonrpc": "2.0", "result": answer(message)})
        except LookupError:
            return self.reply(200, {"error": {"code": -32601, "message": f"Unsupported method {str(message.get('method'))[:64]}."}, "id": message["id"], "jsonrpc": "2.0"})

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
