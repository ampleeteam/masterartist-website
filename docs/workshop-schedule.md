# Workshop schedule

Sabrina's Google Sheet stays private. It is not fetched by GitHub Actions.

Dates on the site are the rows in `data/workshops-seed.json` under `schedule.sessions`. After a change, rebuild with:

```
python3 scripts/expand_sessions.py && python3 scripts/build_site.py
```

A row with `"confirm": true` has no sheet price yet. The page says "Ask us on WhatsApp" and that date is left out of `assets/sessions.json`, so checkout cannot charge RM0.

A row with `"price"` is that price only. It does not inherit the format's pair price. Gingerbread is the exception already stored with its own `pair_price`.

Where the sheet gives a start time and no end, the row is two hours. Past dates drop off in Kuala Lumpur time (UTC+8), including in the browser between builds.

`scripts/sync_schedule.py` can still parse a CSV by hand (`--csv file --dry-run`). Nothing runs it on a schedule.
