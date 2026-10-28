# BidPilot

**Government Contracting Intelligence:** Discover · Analyze · Price · Manage

BidPilot prepares and organizes bids for your review. You keep control of final pricing, certifications, and submission. It never submits anything to DIBBS.

Search every open DLA/DIBBS RFQ across all 666 FSCs, see DLA award history per FSC, and track what you're sourcing and bidding.

- **Site:** `index.html` (GitHub Pages, no server)
- **Data:** `data/rfqs.js`, rebuilt weekdays by GitHub Actions from DIBBS's public daily RFQ files
- **NSN award history:** collected daily from DIBBS "Awards by Award Date" and saved permanently in `data/awards/` (DIBBS purges old awards; this doesn't). Quantity and unit price are read from each award PDF.
- **FSC award history:** pulled live from USAspending.gov (free, no key)
- **CRM (Manage tab):** bid pipeline, suppliers, and quotes. Syncs to a private repo (`crm.json`) once you add the repo and a token in ⚙ Settings; until then it's saved in that browser only.

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

## Read an RFQ PDF (fulfillment requirements)

Download an RFQ PDF from DIBBS, then click **📄 Read RFQ** in the header (or **Read RFQ PDF** in an RFQ's drawer) and drop the file in. BidPilot pulls out:

- delivery days, required delivery date, RDD, FOB, inspection and acceptance points, quantity variance
- boxing and packaging: the MIL-STD-2073 codes (QUP, preservation method, wrap, cushioning, unit and intermediate containers, pack code, packing level), MIL-STD-129 marking, special marking, palletization
- ship-to, parcel-post, freight and mark-for addresses, TCN, and transport notes (FDT, ship by fastest traceable means)
- approved parts, drawings, quality requirement codes (RQ/RP), sampling, IUID, shelf life
- buyer contact, set-aside, and the clauses that matter (Buy American, Berry, hazmat/SDS, WAWF, first article, IUID)

It also gives a plain-English "what it takes to fulfill this line" checklist. **Save to this RFQ** stores the sheet with that RFQ in your pipeline (synced with the CRM), and **Print / save PDF** gives your supplier or packager a one-page copy. The PDF is read inside your browser and never uploaded. pdf.js (Mozilla, Apache 2.0) is bundled in `vendor/`.

## Procurement history from RFQ PDFs

Every RFQ PDF has a "Procurement History" table that goes back years (CAGE, contract, qty, unit price, award date). The daily job reads it for open RFQs (`ingest/history.mjs`) and keeps it permanently in `data/hist/`. That powers the **Last buy** column, the "Not procured in 2+ years" and "Never procured" filters, and the history table in each RFQ's drawer.

## Past-due RFQs that are still open

DLA often leaves an RFQ open long after its return-by date, and a contracting officer may ask for an updated quote. Set **Return-by** to **Past due, still Open on DIBBS** to see them.

Every line that passes its return-by date is queued, and the daily job (`ingest/pastdue.mjs`) looks up its status on DIBBS's NSN search. A line is shown only when DIBBS lists it as **Open**. Closed, awarded and cancelled lines are dropped, and so is anything DIBBS doesn't list after 4 checks. Lines that are shown are re-checked every couple of days, and each one shows the date it was last seen Open.

To pick up older RFQs that were posted before BidPilot started, run the workflow once by hand with **backfill** set to 180. It tries older DIBBS daily files and skips any that DIBBS no longer has.

## How award history builds

The first run pulls as many past days as DIBBS still has (30 days with the backfill). After that it adds every weekday's awards and re-checks the last 7 days for late postings. History only grows, so the longer it runs, the closer it gets to NSN-Now's depth. Award PDFs are read at up to 600 per run; any backlog is finished on later runs.

## CRM sync setup

1. Create a **private** repo named `bidpilot-data` and check **Add a README**.
2. GitHub → profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**. Set Repository access to **Only select repositories → bidpilot-data**, and under Permissions set **Contents: Read and write**. Copy the token.
3. In BidPilot → **⚙ Settings**, enter `tier2rigging/bidpilot-data`, paste the token, and click **Save & sync**. The badge turns **Synced ✓**.
4. On any other device, open BidPilot and enter the same repo and token once.

When the token expires, the badge shows **Sync error**. Generate a new token and paste it in Settings.

## RFQ emails

In an RFQ's drawer, under **Suppliers & quotes**: add approved-source CAGEs as suppliers (with their email), then click **Draft RFQ email**. It opens a pre-filled draft in your email app (Thunderbird). Choose purchasing@ in the From box before you send. To quote several RFQs at once, tick them in **Manage → Bid pipeline** and click **Draft RFQ emails for selected**. That makes one email per supplier. Log each reply's price, lead time, and origin with **Save quote**, then click **Use** to copy it into the bid calculator.

## DIBBS batch quote export

1. In **⚙ Settings → DIBBS batch quote: company answers**, set each answer once: business type, affirmative action, previous contracts, ADR, packaging, hazmat, material, dealer/manufacturer, and your quality system. These are your certifications. BidPilot never picks them for you.
2. In each RFQ's **Bid calculator**, set your bid, then open **DIBBS batch quote details**: delivery days, the approved part you're offering, the manufacturer CAGE, and country of origin. Clicking **Use** on a supplier quote fills most of these.
3. In **Manage → Bid pipeline**, tick the RFQs and click **Export DIBBS batch file**. Anything missing is listed per RFQ. Download the file and upload it on DIBBS under Batch Quote Upload, then review each quote on DIBBS before submitting.

Not exported (quote these on DIBBS directly): foreign-origin items, hazmat items, and QPL items.

## Orders, wins and losses

- Awards to CAGE **175A8** go to `data/my-awards.js` and appear in **Manage → Orders** automatically, with the delivery due date read from the award PDF. To track more CAGEs, add a repo variable or secret `MY_CAGES` (comma-separated) and pass it to the awards step.
- Pipeline RFQs flip to **Won** when an award to your CAGE matches their purchase request number. RFQs you marked **Bid** flip to **Lost** when the award for that PR goes to someone else. Open the RFQ to see who won and at what price.
- Orders track status, due date, supplier, supplier PO and cost, ship date, tracking, invoice/WAWF, and paid date. Orders due within 10 days and not yet shipped are flagged, with a reminder to file a PAR in time.

## Opened RFQs

Opening an RFQ marks it as viewed. In the list, opened RFQs are grayed out and new ones have a blue dot. Tick **Hide RFQs I've opened** to see only new ones. **Mark as not opened** in the drawer resets it. Viewed marks sync with the CRM, and marks for closed RFQs are cleared automatically.

## Search extras

- **Find FSCs for what you sell:** describe your products in plain English (e.g. *cargo slings, webbing, tie-down straps*). BidPilot ranks the FSCs whose names or open-RFQ item names match, shows example items and open-RFQ counts, and adds the ones you tick.

- **Saved views:** set your filters, then click **+ Save view** above the table. Each view becomes a tab, and clicking it restores every filter, the FSC list, and the sort. **Update view** overwrites the open tab, and **×** deletes it. Views sync with the CRM.
- **NSN / part number list:** paste any number of NSNs or part numbers. The list shows open RFQs for those NSNs, or RFQs where one of the numbers is an approved part.
- **Set-aside:** tick several at once.
- **Posted within:** today, 2 days, or 7 days.

## Pipeline workflow

- **Add several RFQs at once:** tick them in Discover (the header box selects the whole page) and click **Add selected to pipeline**. Their approved-source CAGEs become suppliers automatically. Fill in names and emails under **Manage → Suppliers → Missing email**.
- **Statuses:** Watching → Sourcing → Quote requests sent (set automatically when you open an RFQ email draft) → Ready to bid → Bid → Won / Lost / Pass.
- **Pipeline filters:** search, status, close date, and quote state (none, waiting, priced). Save any combination as a pipeline view tab.
- **Related open RFQs:** the drawer lists other open solicitations for the same NSN.
- **Supplier "Include in RFQ emails":** set it to No to leave a supplier out of all RFQ drafts.
- **Email template:** edit the subject and body in ⚙ Settings → RFQ email template, using placeholders like `{items}`, `{contact}` and `{signature}`.
