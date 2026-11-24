#!/usr/bin/env python3
"""Expand the weekly workshop template into dated sessions.

Reads  data/workshops-seed.json  (formats, weekly_schedule_template, schedule
(dated sessions with a theme each), closures, policies, launch), data/themes.json and data/bookings.json, and writes:
  data/workshops.json        everything the site renders from
  data/sessions-preview.md   a human-readable list to check by eye

Rules (handoff 02-SITE-SPEC §2):
- a rolling window of DAYS days from today (or from launch.first_public_sessions
  if that is later); nothing before a format's live_from or an entry's from;
- `alternate_weeks_with`: the entry's own format runs on its first week, the
  alternate format the next week, and so on;
- weekly closures (Saturday; Friday from 12:30; Sunday before 12:00) and no evening (18:00+)
  workshops on Mon/Wed/Fri/Sun;
- session id = {format}-{yyyy-mm-dd}-{HHMM}; theme and booked seats are looked
  up by that id; seats_left = cap - booked;
- prices: Launch Season prices until policies.pricing_window.until, then the
  post_launch_prices set, so the site switches on the date without page edits;
- early bird: formats with early_bird and late_price keep the early bird price
  until 19:00 MYT, policies.early_bird.days_before days before the session
  (default 7). After that the late price is the price in effect. The seat
  cutoff is applied at checkout, where live booking counts exist;
- public holidays (data/public-holidays.json) carry the surcharge unless the
  date is in policies.public_holiday_surcharge_waived_dates.

Usage: python3 scripts/expand_sessions.py [--today YYYY-MM-DD] [--days 42]
"""
import argparse
import datetime as dt
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
MYT = dt.timezone(dt.timedelta(hours=8))


def load(name, default=None):
    p = DATA / name
    if not p.exists():
        return default
    d = json.loads(p.read_text())
    return {k: v for k, v in d.items() if not k.startswith('_')} if isinstance(d, dict) else d


def deep_merge(base, extra):
    """Merge a private overlay (git-ignored: internal notes, unannounced prices) into the seed."""
    for k, v in extra.items():
        if k.startswith('_'):
            continue
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def hm_to_min(t):
    h, m = map(int, t.split(':'))
    return h * 60 + m


def fmt_time(t):
    h, m = map(int, t.split(':'))
    suffix = 'am' if h < 12 else 'pm'
    h12 = h % 12 or 12
    return f'{h12}:{m:02d}{suffix}' if m else f'{h12}{suffix}'


def closed(day, start, closures):
    """True when a session at `start` on `day` breaks a closure rule."""
    start_min = hm_to_min(start)
    for c in closures.get('weekly', []):
        if c['day'] != day:
            continue
        if c.get('all_day'):
            return True
        # `until` closes the morning (a 12:00 start is allowed); `from` closes the rest of the day.
        if 'until' in c and start_min < hm_to_min(c['until']):
            return True
        if 'from' in c and start_min >= hm_to_min(c['from']):
            return True
    if day in closures.get('no_evening_workshops', []) and start_min >= 18 * 60:
        return True
    return False


def prices_from(policies):
    """New workshop, trial and Studio Pass prices apply to sessions on this date onward."""
    return dt.date.fromisoformat(policies.get('prices_from') or '2026-12-07')


def early_bird_until(session_date, policies):
    """7 days before the session at 19:00 MYT, unless policies.early_bird says otherwise."""
    rule = policies.get('early_bird') or {}
    days = int(rule.get('days_before', 7))
    hh, mm = map(int, str(rule.get('until_time', '19:00')).split(':'))
    return dt.datetime.combine(session_date - dt.timedelta(days=days), dt.time(hh, mm), tzinfo=MYT)


def with_holiday(amount, iso, hol, waived, surcharge):
    if amount is None:
        return None
    if iso in hol and iso not in waived and surcharge:
        return round(amount * (1 + surcharge))
    return amount


def price_for(fmt, date, policies, variant=None):
    """(price, pair_price, price_set) for a format on a date."""
    window = policies.get('pricing_window', {})
    launch = date <= dt.date.fromisoformat(window.get('until', '9999-12-31'))
    post = window.get('post_launch_prices', {})
    price, pair = fmt.get('price'), fmt.get('pair_price')
    if fmt.get('bundle'):                       # Kids Art Studio sells as Family Sunday
        price = fmt['bundle']['price']
        if not launch and 'family-sunday' in post:
            price = post['family-sunday']
    elif variant:                               # e.g. the Thursday specialty / cakes Bake Lab
        price = fmt.get(f'price_{variant}', price)
        pair = fmt.get(f'pair_price_{variant}')   # no specialty pair price in the plan yet
        key = f"{fmt['id']}-{variant}"
        if not launch and key in post:
            price, pair = post[key], None
    elif not launch and fmt['id'] in post:
        price = post[fmt['id']]
        pair = None                             # TODO: post-launch pair prices not in the plan yet
    return price, pair, ('launch' if launch else 'post_launch')


def expand(seed, themes, bookings, holidays, today, days, now):
    formats = {f['id']: f for f in seed['formats']}
    closures = seed.get('closures', {})
    policies = seed.get('policies', {})
    waived = set(policies.get('public_holiday_surcharge_waived_dates', []))
    surcharge = policies.get('public_holiday_surcharge', 0)
    first_public = dt.date.fromisoformat(seed.get('launch', {}).get('first_public_sessions', today.isoformat()))
    start = max(today, first_public)
    end = today + dt.timedelta(days=days)
    hol = {h['date']: h['name'] for h in holidays}

    def occurrences():
        """(date, entry, format id) from the weekly template, then from the dated schedule."""
        for entry in seed.get('weekly_schedule_template', []):
            weekday = DAY_NAMES.index(entry['day'])
            d = start + dt.timedelta(days=(weekday - start.weekday()) % 7)
            week_no = 0
            while d <= end:
                fid = entry['format']
                if entry.get('alternate_weeks_with') and week_no % 2 == 1:
                    fid = entry['alternate_weeks_with']
                week_no += 1
                yield d, entry, fid
                d += dt.timedelta(days=7)
        for entry in seed.get('schedule', {}).get('sessions', []):
            d = dt.date.fromisoformat(entry['date'])
            if start <= d <= end:
                yield d, dict(entry, day=DAY_NAMES[d.weekday()]), entry['format']

    sessions, skipped = [], []
    for d, entry, fid in occurrences():
        fmt = formats[fid]
        iso = d.isoformat()
        if fmt.get('status') == 'paused':
            continue
        live_from = dt.date.fromisoformat(max(fmt.get('live_from', iso), entry.get('from', iso)))
        if d < live_from:
            continue
        if closed(entry['day'], entry['time'], closures):
            skipped.append(f"{iso} {entry['time']} {fid}: closure rule")
            continue
        room_rule = next((r for r in seed.get('rooms', []) if r['id'] == entry.get('room')), {})
        blocked = next((b for b in room_rule.get('blocked', []) if b['day'] == entry['day']
                        and hm_to_min(entry['time']) < hm_to_min(b['until'])), None)
        if blocked:
            skipped.append(f"{iso} {entry['time']} {fid}: {room_rule['name']} blocked ({blocked['reason']})")
            continue
        sid = f"{fid}-{iso}-{entry['time'].replace(':', '')}"
        # 29 Nov gingerbread keeps the 3pm session only. A morning row in the
        # private price overlay would otherwise come back on the nightly build.
        if sid == 'bake-lab-2026-11-29-1000':
            skipped.append(f"{iso} {entry['time']} {fid}: morning session removed")
            continue
        variant = entry.get('variant') if fid == entry['format'] else None
        eb = fmt.get('early_bird') if isinstance(fmt.get('early_bird'), dict) else None
        until = None
        early_price = early_pair = late_price = late_pair = None
        # Sessions through the day before prices_from keep the current price, including a
        # dated one-off such as the 29 Nov gingerbread workshop. A row with its own price
        # keeps that price after the cutover too.
        new_prices = d >= prices_from(policies) and not entry.get('price')
        if new_prices and eb and eb.get('price') is not None and fmt.get('late_price') is not None:
            until = early_bird_until(d, policies)
            is_hol = iso in hol
            early_price = with_holiday(eb['price'], iso, hol, waived, surcharge)
            early_pair = with_holiday(eb.get('pair_price'), iso, hol, waived, surcharge)
            late_price = with_holiday(fmt['late_price'], iso, hol, waived, surcharge)
            late_pair = with_holiday(fmt.get('late_pair_price'), iso, hol, waived, surcharge)
            if now < until:
                price, pair, price_set = early_price, early_pair, 'early_bird'
            else:
                price, pair, price_set = late_price, late_pair, 'late'
        else:
            priced = fmt
            if d < prices_from(policies) and 'price_before' in fmt:
                priced = dict(fmt, price=fmt['price_before'],
                              pair_price=fmt.get('pair_price_before', fmt.get('pair_price')))
            price, pair, price_set = price_for(priced, d, policies, variant)
            if price_set == 'launch' and entry.get('price'):   # a dated session priced on its own (e.g. the first week)
                price, pair = entry['price'], entry.get('pair_price', pair)
            is_hol = iso in hol
            if is_hol and iso not in waived and price:
                price = round(price * (1 + surcharge))
        # A dated session can pin its own cap. The 29 Nov gingerbread stays at 20
        # while Bake Lab's usual cap is 24.
        cap = entry.get('cap')
        if cap is None:
            cap = fmt.get(f'cap_{variant}', fmt.get('cap')) if variant else fmt.get('cap')
        booked = int(bookings.get(sid, 0))
        dine = bool(entry.get('dine') or fmt.get('dine_addon'))
        evening = hm_to_min(entry['time']) >= 18 * 60
        end_min = hm_to_min(entry['end']) if entry.get('end') else hm_to_min(entry['time']) + fmt.get('duration_min', 0)
        room_id = entry.get('room')
        room = next((r['name'] for r in seed.get('rooms', []) if r['id'] == room_id), fmt.get('room'))
        s = {
            'id': sid, 'format': fid, 'name': fmt['name'], 'variant': variant, 'discipline': fmt.get('discipline'),
            'date': iso, 'day': entry['day'], 'time': entry['time'],
            'end': f'{end_min // 60:02d}:{end_min % 60:02d}',
            'label': f"{entry['day']} {d.day} {d.strftime('%b')} · {fmt_time(entry['time'])}",
            'room': room, 'price': price, 'pair_price': pair, 'price_set': price_set,
            'price_unit': fmt.get('price_unit'), 'cap': cap, 'cap_unit': fmt.get('cap_unit'),
            'booked': booked, 'seats_left': max(0, cap - booked) if cap else None,
            'dine': bool(dine), 'dine_timing': entry.get('dine_timing', fmt.get('dine_timing', 'before' if evening else 'after')),
            'theme': themes.get(sid) or entry.get('theme'), 'public_holiday': hol.get(iso),
            'surcharge_waived': is_hol and iso in waived,
            'type': fmt.get('type', 'workshop'),
        }
        if entry.get('room_label'):
            s['room'] = entry['room_label']
            s['location_name'] = entry['room_label']
        for key in ('summary', 'pair_word', 'seo_title', 'seo_description'):
            if entry.get(key):
                s[key] = entry[key]
        if until is not None:
            rule = policies.get('early_bird') or {}
            s['early_bird_price'] = early_price
            s['late_price'] = late_price
            s['early_bird_until'] = until.isoformat()
            s['early_bird_seats'] = int(rule.get('seats', 15))
            if early_pair is not None:
                s['early_bird_pair_price'] = early_pair
            if late_pair is not None:
                s['late_pair_price'] = late_pair
        if fmt.get('bundle'):
            s['bundle'] = fmt['bundle']
        if fmt.get('type') == 'course':
            # Shown only as a cohort start; other weeks are a private/corporate hold
            starts = {c['start'] for c in fmt.get('cohorts', [])}
            s['public'] = iso in starts
            s['note'] = 'Cohort start (runs when 6 are enrolled)' if s['public'] else 'Private / corporate hold'
        else:
            s['public'] = True
        sessions.append(s)
    sessions.sort(key=lambda s: (s['date'], s['time'], s['format']))

    # "Sold out — next date": link each session to the next public one of the same format
    for i, s in enumerate(sessions):
        nxt = next((t for t in sessions[i + 1:] if t['format'] == s['format'] and t['public']), None)
        s['next_session'] = nxt['id'] if nxt else None
    return sessions, skipped


def preview(sessions, until):
    lines = ['# Sessions preview', '', f'Generated {dt.date.today().isoformat()} — public sessions to {until}.', '']
    day = None
    for s in sessions:
        if s['date'] > until or not s['public']:
            continue
        if s['date'] != day:
            day = s['date']
            d = dt.date.fromisoformat(day)
            extra = f" — {s['public_holiday']}" + (' (no surcharge)' if s['surcharge_waived'] else '') if s['public_holiday'] else ''
            lines += ['', f"## {d.strftime('%A %-d %B %Y')}{extra}"]
        price = f"RM{s['price']}" + (f" ({s['price_unit']})" if s['price_unit'] else '') if s['price'] else 'TODO price'
        if s.get('bundle'):
            price = f"Family Sunday RM{s['price']} (+RM{s['bundle']['extra_child']} per extra child)"
        if s.get('early_bird_until'):
            pair = ''
            if s.get('early_bird_pair_price'):
                pair = f" · early bird pair RM{s['early_bird_pair_price']}, then RM{s['late_pair_price']}"
            price = (f"early bird RM{s['early_bird_price']} until {s['early_bird_until'][0:16]}, "
                     f"then RM{s['late_price']} (in effect RM{s['price']})")
        else:
            pair = f" · {s.get('pair_word') or 'pair'} RM{s['pair_price']}" if s['pair_price'] else ''
        dine = f" · Dine add-on ({s['dine_timing']})" if s['dine'] else ''
        cap = f"{s['seats_left']} of {s['cap']}{' ' + s['cap_unit'] if s['cap_unit'] else ''} seats left"
        theme = f" · {s['theme']}" if s['theme'] else ''
        variant = f" ({s['variant']})" if s.get('variant') else ''
        lines.append(f"- **{s['time']}–{s['end']}** {s['name']}{variant}{theme} · {s['room']} · {price}{pair}{dine} · {cap}")
    return '\n'.join(lines) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--today', default=dt.date.today().isoformat())
    ap.add_argument('--days', type=int, default=42)
    args = ap.parse_args()
    today = dt.date.fromisoformat(args.today)

    public_seed = json.loads((DATA / 'workshops-seed.json').read_text())
    seed = json.loads(json.dumps(public_seed))   # private overlay is used for calculation only,
    private = DATA / 'private' / 'workshops-private.json'   # never copied into workshops.json
    if private.exists():
        deep_merge(seed, json.loads(private.read_text()))
    themes = load('themes.json', {})
    bookings = load('bookings.json', {})
    holidays = load('public-holidays.json', {}).get('holidays', [])
    now = dt.datetime.now(MYT)
    if today != now.date():
        now = dt.datetime.combine(today, dt.time(12, 0), tzinfo=MYT)
    sessions, skipped = expand(seed, themes, bookings, holidays, today, args.days, now)

    out = {k: v for k, v in public_seed.items() if k not in ('weekly_schedule_template', 'schedule')}
    out['generated'] = dt.datetime.now().isoformat(timespec='seconds')
    out['window'] = {'from': today.isoformat(), 'days': args.days}
    out['sessions'] = sessions
    (DATA / 'workshops.json').write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n')

    two_weeks = (max(today, dt.date.fromisoformat(seed.get('launch', {}).get('first_public_sessions', today.isoformat())))
                 + dt.timedelta(days=13)).isoformat()
    (DATA / 'sessions-preview.md').write_text(preview(sessions, (today + dt.timedelta(days=args.days)).isoformat()))
    pub = [s for s in sessions if s['public']]
    print(f'{len(pub)} public sessions ({len(sessions) - len(pub)} private holds), '
          f'{len(skipped)} skipped by closure rules; preview to {two_weeks} in data/sessions-preview.md')
    for line in skipped:
        print('  skipped:', line)


if __name__ == '__main__':
    main()
