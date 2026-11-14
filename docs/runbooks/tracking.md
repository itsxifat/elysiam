# Runbook: the tracking hub (Meta and GA4), test first, then live

M54 (D-957 to D-973). Settings → Tracking sends every order, whatever its channel, to the ad and
analytics platforms at its stages; the order's Purchase is sent when it is **confirmed**. The
adapters are built from Meta's and Google's documentation and are UNVERIFIED until this runbook
has been followed once with a brand's real accounts.

## 1. What a brand server does by default

Nothing leaves the server. `BRAND_TRACKING_PROVIDER` defaults to `fake`: events are written,
shown in Settings → Tracking's log as sent, and never reach Meta or Google. The screen says so at
the top ("This server is in test mode").

## 2. Set up the platforms (org admin)

In the console, Settings → Tracking → Platforms:

- **Meta:** the pixel id (and the dataset id if it differs), a Conversions API access token from
  Events Manager (a system user's token), and the **test event code** from Events Manager → Test
  events. Tick "Conversions API from the server"; tick "Pixel in the browser" if the website
  should load the pixel.
- **GA4:** the measurement id (`G-…`) and a Measurement Protocol API secret (Admin → Data streams
  → the web stream → Measurement Protocol API secrets). Tick both switches.

A brand that had Website → Tracking or Marketing → Meta set up finds them already filled in
("Your earlier … settings were moved here"); nothing needs entering again.

Under "When an order counts as a Purchase", **Confirmed** is the owner's choice (D-957). Tick
"Test mode" while testing.

## 3. Switch the server to live, in test mode

On the brands server, in the brand's `.env.brand`:

```
BRAND_TRACKING_PROVIDER=live
BRAND_TRACKING_ENABLED=true
```

Both are needed (D-968): `live` alone stops the API and worker at boot. Deploy that brand
(`sh infra/brand/deploy.sh <user@server> <slug>`), or restart its `api` and `worker`.

## 4. Check with test events

1. Settings → Tracking → Meta → **Send test event**. Events Manager → Test events shows
   `ErpConnectionTest` within a minute. GA4's button asks Google's validation endpoint, which
   records nothing and answers whether the event is well formed.
2. Confirm a real order (any channel). With Test mode on, its `Purchase` goes under the test
   code and appears in Test events, not in the brand's results.
3. Settings → Tracking → Event log: each event shows each platform's status; a failed one shows
   Meta's or Google's reason and a **Retry** button.

Record in `docs/decisions.md` (Unverified integrations) the date and what Meta and GA4 answered;
that makes the adapters verified.

## 5. Go live

Untick **Test mode** and clear the Meta test event code, then save. From then on events count.

## 6. The website

The website reads `GET /storefront/v1/tracking/config`: `purchaseStage` is `confirmed`, and the
`Purchase` route has `client: false`, so its confirmation page must not fire a browser Purchase.
It should fire `OrderPlaced` with event id `placed_<order no>` instead (D-965), and send the click
ids and UTMs at checkout (`tracking.fbclid`, `gclid`, `ttclid`, `utmCampaign`, `campaignLinkCode`
and the rest, all optional). An older website that sends none of them keeps working.

## 7. If something goes wrong

- Nothing in Events Manager: check §1 (still `fake`?), the destination's "Ready" badge, and the
  log's reason.
- "Too old for the platform to take": Meta refuses events older than seven days, GA4 misdates
  past 72 hours, so those are skipped on purpose.
- To stop sending at once: untick the platform's server switch in Settings → Tracking, or set
  `BRAND_TRACKING_PROVIDER=fake` and restart.
