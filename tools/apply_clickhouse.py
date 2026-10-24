#!/usr/bin/env python3
"""Applies db/clickhouse/migrations/*.sql in name order (statements end with ';' at the end of a line; the files are
idempotent), as the mock does on start. CH_URL (e.g. http://localhost:8123/?database=sms_edr) and CH_AUTH (user:pw)."""
import base64
import glob
import os
import re
import sys
import urllib.request

url = os.environ["CH_URL"]
auth = base64.b64encode(os.environ["CH_AUTH"].encode()).decode()
here = os.path.dirname(os.path.abspath(__file__))
files = sorted(glob.glob(os.path.join(here, "..", "db", "clickhouse", "migrations", "*.sql")))
for path in files:
    sql = re.sub(r"(?m)^\s*--.*$", "", open(path, encoding="utf-8").read())
    for stmt in (s.strip() for s in re.split(r";\s*$", sql, flags=re.M)):
        if not stmt:
            continue
        request = urllib.request.Request(url, data=stmt.encode(), headers={"Authorization": f"Basic {auth}"})
        try:
            urllib.request.urlopen(request, timeout=120).read()
        except urllib.error.HTTPError as e:
            sys.exit(f"{os.path.basename(path)}: {e.read().decode()}")
    print(f"applied {os.path.basename(path)}")
