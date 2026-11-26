# Workshop schedule sheet

Dated workshops come from Sabrina's Google Sheet, **Master Artist Workshop Schedule**.

Sheet id: `1AdsDRm7kp0spt60pJZk7KM9Nmalu3JirfRVHZox87lY`

`scripts/sync_schedule.py` reads that sheet as CSV and writes `data/schedule-import.json`. `scripts/expand_sessions.py` uses those rows, when the file is present, in place of the dated list in `data/workshops-seed.json`. The nightly workflow `.github/workflows/schedule.yml` does the fetch and rebuild. No key is stored in the repo.

Until the sheet can be read, the site keeps the dates committed in `data/workshops-seed.json`. Past dates also drop in the browser (Kuala Lumpur time, UTC+8) so a stale build does not keep showing them.

## Access the workflow needs

One of these. Nothing else.

1. **Share the file** as "Anyone with the link can view". These URLs then work with no secret:
   - `https://docs.google.com/spreadsheets/d/1AdsDRm7kp0spt60pJZk7KM9Nmalu3JirfRVHZox87lY/export?format=csv`
   - `https://docs.google.com/spreadsheets/d/1AdsDRm7kp0spt60pJZk7KM9Nmalu3JirfRVHZox87lY/gviz/tq?tqx=out:csv`

2. **Publish to the web** (File → Share → Publish to the web → the schedule tab → Comma-separated values). Set the GitHub Actions **variable** `SCHEDULE_CSV_URL` to that published CSV link. The link is public. It is not a secret.

3. Optional, only if you also want an API key: GitHub Actions **secret** `GOOGLE_SHEETS_API_KEY`. An API key cannot open a private file, so the sheet still has to be shared as in step 1. Do not commit the key.

Checked on 26 Nov 2026: the export, the gviz URL, and "publish to the web" all redirect to a Google sign-in. The sheet is not readable yet, so its columns and upcoming rows are not in this repo.

## Columns the sync understands

The header row can use any of these names. A date column is required. A start time can be `15:00`, `3pm`, or a range such as `3-5pm` in the start cell.

| Field | Accepted headers |
| --- | --- |
| Date | Date, Session date, Workshop date |
| Start | Start, Start time, Time, From |
| End | End, End time, Finish, To |
| Workshop | Format, Workshop, Workshop type, Type, Class |
| Theme | Theme, Title, Session, Session name, Name |
| Price | Price, Price RM, Fee, RM, Cost |
| Pair | Pair, Pair price, 2 pax, Two pax |
| Seats | Cap, Capacity, Seats, Max |
| Room | Room, Venue, Location |
| Public | Public, Publish, Live, Status |
| Notes | Summary, Notes, Description |

Workshop names map onto the site formats: textured / impasto, acrylic, watercolour, glow, candle, crochet, bake lab (including bread and gingerbread), and kids / Family Sunday. The price cell is the only price published for that date. A pair column is the two-person total when the sheet has one. Rows marked private, paused, or no are skipped.
