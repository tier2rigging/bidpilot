# BidPilot

**Government Contracting Intelligence:** Discover · Analyze · Price · Manage

BidPilot prepares and organizes bids for your review. You keep control of final pricing, certifications, and submission. It never submits anything to DIBBS.

Search every open DLA/DIBBS RFQ across all 666 FSCs, see DLA award history per FSC, and track what you're sourcing and bidding.

- **Site:** `index.html` (GitHub Pages, no server)
- **Data:** `data/rfqs.js`, rebuilt weekdays by GitHub Actions from DIBBS's public daily RFQ files
- **NSN award history:** collected daily from DIBBS "Awards by Award Date" and saved permanently in `data/awards/` (DIBBS purges old awards; this doesn't). Quantity and unit price are read from each award PDF.
- **FSC award history:** pulled live from USAspending.gov (free, no key)
- **Pipeline:** saved in your browser; use Export CSV to back it up

## Setup (about 10 minutes)

1. On GitHub, create a new repo (e.g. `bidpilot`). Public or private both work.
2. Upload everything in this folder, keeping the folder structure (`.github/workflows/daily.yml` must keep its path).
3. Repo **Settings → Actions → General → Workflow permissions** → select **Read and write permissions** → Save.
4. Repo **Settings → Pages** → Source: **Deploy from a branch**, branch `main`, folder `/ (root)` → Save.
5. **Actions** tab → **Daily DIBBS update** → **Run workflow** → set days to `30` → Run. This first backfill takes a few minutes and replaces the sample data.
6. Open your Pages URL. After that it updates itself weekdays around 7:17am and 1:17pm Eastern.

## If the daily job fails

Open the failed run in the Actions tab and read the log.

- `DIBBS WAF rejected` or `consent POST failed`: DIBBS's firewall blocked GitHub's servers. Run it from your own PC instead: install Node 20+, then in this folder run `node ingest/fetch.mjs --days 30`, then upload the new `data/rfqs.js`.
- Award history says "Couldn't load": USAspending is down or blocked by your browser. The link in that panel opens their site directly.

## Using it

- **Add FSC:** type a code (`1670`) or a word (`parachute`, `webbing`, `sling`) and pick from the list. Add as many as you want, then **Save as My FSCs**.
- **Open RFQs by FSC** (left panel): which categories have the most open RFQs right now, given your other filters. This is the fastest way to find new categories.
- **Approved sources:** from the DIBBS batch file, listing every CAGE and part number DLA will accept. Filter to **None listed** for items anyone can supply, or enter CAGE codes to see every open RFQ a specific manufacturer is approved on. That's how you find which suppliers to call.
- **AMSC filter → Open competition:** hides approved-source items you can't quote without the exact manufacturer part.
- **Award history filter:** hide NSNs where the same CAGE won the last 3 awards, or where an approved source won the last one. **Last $/ea** column shows the last awarded unit price.
- **Click any RFQ:** RFQ PDF, solicitation page, NSN history and quote form on DIBBS, a margin calculator, pipeline status, every collected award for that NSN (CAGE, qty, unit price, contract PDF, MOD flag with package link), a **Bid = last award +3%/yr** button, and DLA award history for that FSC.

## How award history builds

The first run pulls as many past days as DIBBS still has (30 days with the backfill). After that it adds every weekday's awards and re-checks the last 7 days for late postings. History only grows, so the longer it runs, the closer it gets to NSN-Now's depth. Award PDFs are read at up to 600 per run; any backlog is finished on later runs.
