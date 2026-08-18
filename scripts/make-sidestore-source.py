#!/usr/bin/env python3
"""Generate the SideStore source JSON for a built .ipa.

Usage: make-sidestore-source.py <ipa> <download-url> <out.json>

Reads version, bundle id, and minimum OS straight from the ipa's Info.plist
so the source can never drift from the binary it points at.
"""
import datetime
import json
import plistlib
import sys
import zipfile

ipa_path, download_url, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

with zipfile.ZipFile(ipa_path) as z:
    plist_name = next(
        n for n in z.namelist()
        if n.count("/") == 2 and n.endswith(".app/Info.plist")
    )
    info = plistlib.loads(z.read(plist_name))

version = info["CFBundleShortVersionString"]
size = __import__("os").path.getsize(ipa_path)
release = {
    "version": version,
    "date": datetime.date.today().isoformat(),
    "downloadURL": download_url,
    "size": size,
    "minOSVersion": info.get("MinimumOSVersion", "15.1"),
    "localizedDescription": "Development build from main.",
}
app = {
    "name": "landline",
    "bundleIdentifier": info["CFBundleIdentifier"],
    "developerName": "Tristan Colby",
    "subtitle": "Agent sessions in your pocket",
    "localizedDescription": (
        "Client for the landline agent session runtime: spawn, watch, and "
        "drive terminal sessions running on your own machine — real TUI "
        "rendering, per-session isolated environments, instant reattach."
    ),
    "iconURL": "https://raw.githubusercontent.com/tcolb/landline/main/apps/mobile/assets/icon.png",
    "tintColor": "#238636",
    "screenshots": [],
    "versions": [release],
    # Legacy single-version fields for older source parsers.
    "version": version,
    "versionDate": release["date"],
    "versionDescription": release["localizedDescription"],
    "downloadURL": download_url,
    "size": size,
}
source = {
    "name": "landline",
    "identifier": "com.tcolb.landline.source",
    "apps": [app],
}
with open(out_path, "w") as f:
    json.dump(source, f, indent=2)
print(f"source: {out_path} -> {download_url} v{version} ({size} bytes)")
