#!/usr/bin/env python3
"""Pull Sabrina's workshop schedule into data/schedule-import.json.

The sheet is the source of truth for dated sessions. This script does not
embed a credential. It reads a CSV that is already public:

  1. SCHEDULE_CSV_URL, if set (the "Publish to the web" CSV link).
  2. Otherwise the spreadsheet export and the gviz CSV, which answer once the
     file is shared as "Anyone with the link can view".

If neither works and GOOGLE_SHEETS_API_KEY is set in the environment, it tries
the Sheets API. That key only works for a sheet that is already shared with
anyone who has the link. The key is never written to disk or printed.

A failed read leaves the existing schedule alone and exits 0, so a nightly
build is not wiped. A CSV that parses as a schedule is written only with
--write. --dry-run prints the parsed JSON to stdout.

Usage:
  python3 scripts/sync_schedule.py --dry-run
  python3 scripts/sync_schedule.py --write
  python3 scripts/sync_schedule.py --csv tests/fixtures/schedule.csv --dry-run
"""
import csv
import datetime as dt
import io
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
OUT = DATA / 'schedule-import.json'
SHEET_ID = '1AdsDRm7kp0spt60pJZk7KM9Nmalu3JirfRVHZox87lY'
EXPORT_URL = f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv'
GVIZ_URL = f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv'
API_URL = f'https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/A:Z'

# Longer phrases first so "family sunday" is not swallowed by a shorter token.
FORMATS = [
    ('kids', ('family sunday', 'kids art studio', 'kids workshop', 'kids workshops', 'kids')),
    ('textured-canvas', ('textured & impasto', 'textured and impasto', 'textured canvas', 'impasto', 'textured')),
    ('watercolour-botanicals', ('watercolour', 'watercolor', 'botanical')),
    ('acrylic-canvas', ('acrylic',)),
    ('glow-canvas', ('glow-in-the-dark', 'glow in the dark', 'glow canvas', 'glow')),
    ('candle-making', ('candle',)),
    ('crochet-bag', ('crochet', 'chunky yarn')),
    ('bake-lab', ('bake lab', 'bake-lab', 'baking', 'bread', 'gingerbread', 'bake')),
]

HEADER_ALIASES = {
    'date': ('date', 'session date', 'workshop date', 'day date'),
    'start': ('start', 'start time', 'time', 'from'),
    'end': ('end', 'end time', 'finish', 'to'),
    'format': ('format', 'workshop', 'workshop type', 'type', 'session type', 'class'),
    'theme': ('theme', 'title', 'session', 'session name', 'name', 'topic'),
    'price': ('price', 'price rm', 'fee', 'rm', 'cost', 'per person'),
    'pair': ('pair', 'pair price', '2 pax', 'two pax', '2pax', 'pair rm'),
    'cap': ('cap', 'capacity', 'seats', 'max', 'max seats', 'pax'),
    'room': ('room', 'venue', 'location'),
    'public': ('public', 'publish', 'live', 'status', 'show'),
    'summary': ('summary', 'notes', 'note', 'description'),
}


def norm(text):
    return re.sub(r'[^a-z0-9]+', ' ', (text or '').strip().lower()).strip()


def looks_like_csv(text):
    if not text:
        return False
    sample = text.lstrip()[:800].lower()
    if sample.startswith('<!doctype') or sample.startswith('<html') or 'accounts.google.com' in sample:
        return False
    if 'serviceLogin' in text[:1500] or 'Sign in' in text[:400] and '<html' in sample:
        return False
    first = text.splitlines()[0] if text.splitlines() else ''
    return (',' in first or '\t' in first) and not first.lower().startswith('<')


def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': 'masterartist-schedule-sync'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            charset = 'utf-8'
            ctype = res.headers.get('Content-Type') or ''
            match = re.search(r'charset=([\w.-]+)', ctype, re.I)
            if match:
                charset = match.group(1)
            return raw.decode(charset, errors='replace')
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return f'__ERROR__ {exc}'


def fetch_api(key):
    """Sheets API values. Failures are returned as None so the key never lands in a log."""
    url = API_URL + '?' + urllib.parse.urlencode({'key': key})
    req = urllib.request.Request(url, headers={'User-Agent': 'masterartist-schedule-sync'})
    try:
        with urllib.request.urlopen(req, timeout=25) as res:
            payload = json.loads(res.read().decode('utf-8', errors='replace'))
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
        return None
    values = payload.get('values') if isinstance(payload, dict) else None
    if not values:
        return None
    buf = io.StringIO()
    csv.writer(buf).writerows(values)
    return buf.getvalue()


def fetch_public():
    override = (os.environ.get('SCHEDULE_CSV_URL') or '').strip()
    urls = [override] if override else []
    urls.extend([EXPORT_URL, GVIZ_URL])
    for url in urls:
        body = fetch(url)
        if body.startswith('__ERROR__'):
            continue
        if looks_like_csv(body):
            return body, url
    key = (os.environ.get('GOOGLE_SHEETS_API_KEY') or '').strip()
    if key:
        body = fetch_api(key)
        if body and looks_like_csv(body):
            return body, 'sheets-api'
    return None, None


def header_map(row):
    found = {}
    cells = [norm(c) for c in row]
    for key, aliases in HEADER_ALIASES.items():
        for i, cell in enumerate(cells):
            if cell in aliases or any(cell == alias for alias in aliases):
                found[key] = i
                break
    if 'date' not in found:
        return None
    return found


def cell(row, idx):
    if idx is None or idx >= len(row):
        return ''
    return (row[idx] or '').strip()


def money(text):
    if not text:
        return None
    match = re.search(r'(\d{1,5})(?:[.,](\d{2}))?', text.replace(',', ''))
    if not match:
        return None
    ringgit = int(match.group(1))
    if match.group(2) and match.group(2) != '00':
        return None
    return ringgit


def clock(text):
    """Return HH:MM or None. Accepts 15:00, 3pm, 3:30pm, 3.30 pm."""
    raw = (text or '').strip().lower().replace('.', ':')
    raw = re.sub(r'\s+', '', raw)
    m = re.fullmatch(r'(\d{1,2}):(\d{2})', raw)
    if m:
        h, minute = int(m.group(1)), int(m.group(2))
        if 0 <= h <= 23 and 0 <= minute <= 59:
            return f'{h:02d}:{minute:02d}'
        return None
    m = re.fullmatch(r'(\d{1,2})(?::(\d{2}))?(am|pm)', raw)
    if not m:
        return None
    h = int(m.group(1))
    minute = int(m.group(2) or 0)
    if m.group(3) == 'pm' and h != 12:
        h += 12
    if m.group(3) == 'am' and h == 12:
        h = 0
    if not (0 <= h <= 23 and 0 <= minute <= 59):
        return None
    return f'{h:02d}:{minute:02d}'


def time_range(text):
    """A cell like '3-5pm' or '10am-12pm' or '15:00-17:00'."""
    raw = (text or '').strip().lower()
    parts = re.split(r'\s*(?:–|—|-|to)\s*', raw)
    if len(parts) != 2:
        start = clock(raw)
        return (start, None) if start else (None, None)
    # "3-5pm": the first half may omit am/pm. Copy the suffix when it has none.
    suffix = ''
    if re.search(r'(am|pm)\s*$', parts[1]) and not re.search(r'(am|pm)\s*$', parts[0]):
        suffix = 'pm' if parts[1].rstrip().endswith('pm') else 'am'
    start = clock(parts[0] + suffix)
    end = clock(parts[1])
    return start, end


def parse_date(text, today):
    raw = (text or '').strip()
    if not raw:
        return None
    raw = re.sub(r'^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+', '', raw, flags=re.I)
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%d-%m-%Y', '%d %b %Y', '%d %B %Y', '%d %b %y', '%d %B %y'):
        try:
            return dt.datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    m = re.fullmatch(r'(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})', raw)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        day, month = (a, b) if a > 12 or b <= 12 else (a, b)
        if a <= 12 and b <= 12:
            day, month = a, b  # Malaysia writes the day first
        try:
            return dt.date(y, month, day)
        except ValueError:
            return None
    return None


def match_format(text):
    hay = norm(text)
    if not hay:
        return None
    if hay.replace(' ', '-') in {fid for fid, _ in FORMATS}:
        return hay.replace(' ', '-')
    for fid, phrases in FORMATS:
        for phrase in phrases:
            if norm(phrase) in hay:
                return fid
    return None


def match_room(text, room_ids):
    key = norm(text)
    if not key:
        return None
    if key in room_ids:
        return room_ids[key]
    hits = [rid for name, rid in room_ids.items() if key in name or name in key]
    if len(set(hits)) == 1:
        return hits[0]
    return None


def is_public(text):
    hay = norm(text)
    if not hay:
        return True
    if hay in ('no', 'n', 'false', '0', 'private', 'paused', 'hidden', 'draft', 'internal'):
        return False
    return True


def rooms_index():
    seed = json.loads((DATA / 'workshops-seed.json').read_text())
    by_name = {}
    for room in seed.get('rooms', []):
        by_name[norm(room['name'])] = room['id']
        by_name[norm(room['id'])] = room['id']
    return by_name


def parse_csv(text, today=None):
    today = today or dt.date.today()
    sample = text.lstrip('\ufeff')
    # Google's CSV is comma-separated. A tab-separated export is accepted too.
    dialect_text = sample[:2048]
    try:
        dialect = csv.Sniffer().sniff(dialect_text, delimiters=',\t;')
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(sample), dialect))
    header_at = None
    mapping = None
    for i, row in enumerate(rows[:15]):
        mapping = header_map(row)
        if mapping:
            header_at = i
            break
    if mapping is None:
        raise ValueError('no header row with a date column')
    columns = [c.strip() for c in rows[header_at]]
    room_ids = rooms_index()
    sessions = []
    for row in rows[header_at + 1:]:
        if not any(cell.strip() for cell in row):
            continue
        if not is_public(cell(row, mapping.get('public'))):
            continue
        day = parse_date(cell(row, mapping['date']), today)
        if not day:
            continue
        start_cell = cell(row, mapping.get('start'))
        end_cell = cell(row, mapping.get('end'))
        start, end = time_range(start_cell) if start_cell and not clock(start_cell) else (clock(start_cell), clock(end_cell))
        if clock(start_cell):
            start = clock(start_cell)
            ranged_end = time_range(start_cell)[1]
            end = clock(end_cell) or ranged_end
        if not start:
            continue
        if not end:
            # Two hours is the usual workshop. The site still prefers an explicit end.
            h, m = map(int, start.split(':'))
            total = h * 60 + m + 120
            end = f'{total // 60:02d}:{total % 60:02d}'
        fmt = match_format(cell(row, mapping.get('format'))) or match_format(cell(row, mapping.get('theme')))
        if not fmt:
            continue
        theme = cell(row, mapping.get('theme'))
        workshop = cell(row, mapping.get('format'))
        if theme and workshop and norm(theme) == norm(workshop):
            theme = ''
        room_raw = cell(row, mapping.get('room'))
        room_id = match_room(room_raw, room_ids)
        item = {
            'date': day.isoformat(),
            'time': start,
            'end': end,
            'format': fmt,
        }
        if theme:
            item['theme'] = theme
        price = money(cell(row, mapping.get('price')))
        pair = money(cell(row, mapping.get('pair')))
        cap = money(cell(row, mapping.get('cap')))
        if price is not None:
            item['price'] = price
        if pair is not None:
            item['pair_price'] = pair
        if cap is not None:
            item['cap'] = cap
        if room_id:
            item['room'] = room_id
        elif room_raw:
            item['room_label'] = room_raw
        summary = cell(row, mapping.get('summary'))
        if summary:
            item['summary'] = summary
        sessions.append(item)
    sessions.sort(key=lambda s: (s['date'], s['time'], s['format']))
    return {'columns': columns, 'sessions': sessions}


ACCESS = """Could not read the workshop sheet. Nothing was changed.

Share "Master Artist Workshop Schedule" so a scheduled build can fetch it with no key in the repo. Either:

1. Share the file as "Anyone with the link can view". These URLs then work:
   {export}
   {gviz}

2. Or File → Share → Publish to the web, choose the schedule tab, CSV, and set the GitHub Actions variable SCHEDULE_CSV_URL to that published CSV link. The link is public. It is not a secret.

A private sheet needs an API key as well as link sharing (an API key cannot open a private file). Put that key only in the GitHub Actions secret GOOGLE_SHEETS_API_KEY. Do not commit it. A service-account JSON is not used.

Sheet id: {sheet}
""".format(export=EXPORT_URL, gviz=GVIZ_URL, sheet=SHEET_ID)


def github_output(updated):
    path = os.environ.get('GITHUB_OUTPUT')
    if not path:
        return
    with open(path, 'a', encoding='utf-8') as handle:
        handle.write(f'updated={"true" if updated else "false"}\n')


def main(argv):
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true', help='write data/schedule-import.json')
    ap.add_argument('--dry-run', action='store_true', help='print JSON to stdout and do not write')
    ap.add_argument('--csv', help='parse this file instead of fetching the sheet')
    args = ap.parse_args(argv)
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date()
    if args.csv:
        text = pathlib.Path(args.csv).read_text(encoding='utf-8')
        source = args.csv
    else:
        text, source = fetch_public()
        if not text:
            print(ACCESS, file=sys.stderr)
            github_output(False)
            return 0
    try:
        parsed = parse_csv(text, today)
    except ValueError as exc:
        print(f'schedule CSV was unreadable: {exc}', file=sys.stderr)
        github_output(False)
        return 1
    if not parsed['sessions']:
        print('schedule CSV had no usable session rows; leaving the site schedule as it is', file=sys.stderr)
        github_output(False)
        return 1
    doc = {
        'source': 'google-sheet',
        'sheet_id': SHEET_ID,
        'fetched': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'fetched_from': 'local-csv' if args.csv else ('env' if os.environ.get('SCHEDULE_CSV_URL') else 'public-csv'),
        'columns': parsed['columns'],
        'sessions': parsed['sessions'],
    }
    if args.dry_run or not args.write:
        json.dump(doc, sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write('\n')
        github_output(False)
        return 0
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
    print(f"wrote {OUT.relative_to(ROOT)} ({len(parsed['sessions'])} rows) from {doc['fetched_from']}", file=sys.stderr)
    github_output(True)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
