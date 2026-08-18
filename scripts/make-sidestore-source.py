#!/usr/bin/env python3
"""Generate the SideStore source JSON for built .ipa files.

Usage: make-sidestore-source.py <out.json> <ipa> <download-url> [<ipa> <download-url>]...

Reads name, version, bundle id, and minimum OS straight from each ipa's
Info.plist so the source can never drift from the binaries it points at.
"""
import datetime
import json
import os
import plistlib
import sys
import zipfile

ICON_URL = "https://raw.githubusercontent.com/tcolb/landline/main/apps/mobile/assets/icon.png"

DESCRIPTIONS = {
    "com.tcolb.landline": (
        "Client for the landline agent session runtime: spawn, watch, and "
        "drive terminal sessions running on your own machine — real TUI "
        "rendering, per-session isolated environments, instant reattach."
    ),
    "com.tcolb.landline.dev": (
        "Development client: loads the app's JavaScript live from a Metro "
        "dev server on your machine for fast iteration. Install alongside "
        "the regular app."
    ),
}

def app_entry(ipa_path, download_url):
    with zipfile.ZipFile(ipa_path) as z:
        plist_name = next(
            n for n in z.namelist()
            if n.count("/") == 2 and n.endswith(".app/Info.plist")
        )
        info = plistlib.loads(z.read(plist_name))
    version = info["CFBundleShortVersionString"]
    bundle = info["CFBundleIdentifier"]
    name = info.get("CFBundleDisplayName") or info.get("CFBundleName") or "landline"
    size = os.path.getsize(ipa_path)
    date = datetime.date.today().isoformat()
    release = {
        "version": version,
        "date": date,
        "downloadURL": download_url,
        "size": size,
        "minOSVersion": info.get("MinimumOSVersion", "15.1"),
        "localizedDescription": "Development build from main.",
    }
    return {
        "name": name,
        "bundleIdentifier": bundle,
        "developerName": "Tristan Colby",
        "subtitle": "Agent sessions in your pocket",
        "localizedDescription": DESCRIPTIONS.get(bundle, DESCRIPTIONS["com.tcolb.landline"]),
        "iconURL": ICON_URL,
        "tintColor": "#238636",
        "screenshots": [],
        "versions": [release],
        # Legacy single-version fields for older source parsers.
        "version": version,
        "versionDate": date,
        "versionDescription": release["localizedDescription"],
        "downloadURL": download_url,
        "size": size,
    }

out_path = sys.argv[1]
pairs = sys.argv[2:]
assert pairs and len(pairs) % 2 == 0, "want <ipa> <url> pairs"
apps = [app_entry(pairs[i], pairs[i + 1]) for i in range(0, len(pairs), 2)]
source = {
    "name": "landline",
    "identifier": "com.tcolb.landline.source",
    "apps": apps,
}
with open(out_path, "w") as f:
    json.dump(source, f, indent=2)
for a in apps:
    print(f"source: {a['bundleIdentifier']} v{a['version']} ({a['size']} bytes)")
