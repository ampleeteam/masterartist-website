# Google Ads → WhatsApp

Paid Ads visitors who click a WhatsApp button are tagged with a `G-XXXXXX` code. The studio sees that code in the chat, and the CRM receives the click ids.

## Final URL suffix

Paste this into Google Ads as the **Final URL suffix** (account or campaign). Leave **auto-tagging on**.

```
utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}&ma_adgroup={adgroupid}&ma_device={device}&ma_network={network}
```

Auto-tagging adds `gclid` (and `gbraid` or `wbraid` on app clicks). Do not put `gclid` in the suffix. A hand-written `gclid` would replace the one Google generates.

`utm_source=google` and `utm_medium=cpc` match the labels the site already understands (`google` counts as a Google visit; `cpc`, `paid`, and `ppc` count as paid). `utm_campaign`, `utm_content`, and `utm_term` were already stored. `utm_id` is optional and is captured when Google adds it. `ma_adgroup`, `ma_device`, and `ma_network` are new ValueTrack fields (`{adgroupid}`, `{device}`, `{network}`) so the CRM can see the ad group, device, and network. Nothing in the suffix is a person’s name, email, or phone.

## What happens on the site

The landing URL is stored in the browser for 30 days (first visit and most recent visit). No cookies and no personal details.

When that visitor clicks any WhatsApp button (`wa.me` or `api.whatsapp.com`, including workshop booking and trial forms), the chat opens on **60102779426** with the existing prefilled message plus a last line:

```
(ref G-XXXXXX)
```

The same code is reused for 30 days for that browser. The click is not delayed if the CRM request fails.

A separate note is sent to `https://fudaosneozobacdalncv.supabase.co/functions/v1/ad-ref` with the ref, `gclid`, `gbraid`, `wbraid`, the UTM and `ma_*` fields, the landing path, the referrer host, when we first saw the browser, and when they clicked.

Visitors from Meta or TikTok are unchanged: no `G-` code is added, and any `Ref: FB` line the older pages already add stays as it is.
