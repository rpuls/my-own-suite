"""Points the web client's PostHog and Stripe at Stirling's own server, where the requests fail.

A backstop: 3.5.0 loads PostHog only with analytics on and Stripe only on its billing screen, and
earlier versions loaded both on every page. Each swap must match exactly once, or the build stops.
"""
import shutil
import sys
import zipfile

JAR = '/app/app.jar'
SWAPS = {
    'host:"https://eu.i.posthog.com"': 'host:"/mos-blocked/posthog"',
    '"https://js.stripe.com"': '"/mos-blocked/stripe"',
}

counts = dict.fromkeys(SWAPS, 0)
with zipfile.ZipFile(JAR) as source, zipfile.ZipFile(f'{JAR}.patched', 'w') as target:
    for entry in source.infolist():
        data = source.read(entry.filename)
        if entry.filename.startswith('static/assets/') and entry.filename.endswith('.js'):
            text = data.decode('utf-8')
            for old, new in SWAPS.items():
                counts[old] += text.count(old)
                text = text.replace(old, new)
            data = text.encode('utf-8')
        target.writestr(entry, data, compress_type=entry.compress_type)

if any(count != 1 for count in counts.values()):
    sys.exit(f'The web client no longer matches what this patch expects: {counts}')
shutil.move(f'{JAR}.patched', JAR)
