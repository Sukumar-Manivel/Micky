# Research findings and decisions

Research done on 10 October 2026 by three parallel research agents (free infrastructure; India payments and law; video verification). Free tiers and regulations change often, so re-check anything marked *verify before launch*.

> Not legal or tax advice. Talk to a CA and a lawyer before taking real money.

## Decisions that changed the original plan

| Topic | Original plan | Decision | Why |
|---|---|---|---|
| Uploader payments | Razorpay Route splits each payment automatically | **Collect the full payment, keep each uploader's share in an internal ledger, pay out in batches** | Since the RBI Payment Aggregator Directions (Sep 2025), Razorpay only enables Route for businesses with more than ₹40 lakh turnover. A new startup can't use it at launch. |
| Login | Phone OTP | **Email + password** (email OTP later) | SMS OTP in India needs TRAI DLT registration (~₹5,900, business documents, 3–7 days). Email is free. |
| Serving preview video | Public files on Cloudflare R2 + CDN | **API streams encrypted HLS previews through short-lived signed URLs**, from local disk or R2 | Cloudflare's free CDN terms ban serving mainly video without a paid video product. Streaming through the API also enforces "only approved channels can watch". |
| ORM | Prisma | **Drizzle ORM** | Pure TypeScript, no engine binaries to download, works the same on ARM servers. |
| AI detection | One "is it AI?" answer | **Evidence report with a risk level; a human always decides** | Detectors claim ~98% on their own test sets but caught as little as 9–24% of modern generator output in independent tests (OpenFake, 2025). |

## Infrastructure (all free tiers)

| Layer | Pick | Key limit | Watch out for |
|---|---|---|---|
| Server | Oracle Cloud Always Free (Ampere A1) | 2 OCPU / 12 GB RAM (halved in 2026), 200 GB disk, 10 TB/month egress | Idle instances can be reclaimed (CPU, network and memory all under 20% for 7 days). "Out of capacity" errors can last days. Card required for signup. |
| Frontend | Cloudflare Pages | Unlimited static requests, 500 builds/month | Never process card details on your own pages (use Razorpay's hosted checkout). **Vercel Hobby forbids commercial use.** |
| Object storage | Cloudflare R2 | 10 GB, free egress | Only previews and thumbnails go here; originals stay on the server disk. |
| Database / queue | PostgreSQL + Redis in Docker on the server | Disk size | Upstash's free Redis runs out quickly with BullMQ's polling. Supabase/Neon free tiers pause when idle. |
| Email | Resend (3,000/month, 100/day) | | |
| Errors / uptime | Sentry Developer (5k errors), Better Stack (10 monitors) | | Uptime Kuma on the same server can't detect that server going down. |
| Domain | `.in` for about ₹100–170 the first year | Renewals cost more | The only unavoidable cost. |

## Payments (Razorpay)

- **Development:** test keys + Orders API + Standard Checkout + webhooks. The app also has a `mock` provider so the whole flow can be demoed without any keys.
- **Launch:** activate Razorpay as an individual or sole proprietor (PAN, KYC; GST optional at first). Collect PAN and UPI ID from uploaders before their first payout. *Ask Razorpay support in writing whether "collect then pay out" is allowed for your account.*
- **Fees:** about 2% + GST per payment.
- **Verifying a payment (Orders API):** `HMAC_SHA256(order_id + "|" + payment_id, key_secret) == razorpay_signature`, using the order id stored on our server.
- **Verifying a webhook:** `HMAC_SHA256(raw_request_body, webhook_secret) == X-Razorpay-Signature`, compared in constant time, before parsing the body. Grant the licence on `order.paid` / `payment.captured`. Handlers must be idempotent: Razorpay retries webhooks.

## Tax (consult a CA)

- TDS under Section 194-O: 0.1% of payouts to each uploader; none for a resident individual under ₹5 lakh a year who has given PAN; 5% without PAN.
- GST: an e-commerce operator that must collect TCS has to register regardless of turnover. Whether Micky counts as one needs a CA's view.

## Law (consult a lawyer)

- **IT Rules 2021, amended February 2026:**
  - Remove content within **3 hours** of a court or government order.
  - Remove non-consensual intimate or morphed imagery within **2 hours**.
  - Resolve grievances within **7 days**.
  - Clearly label synthetic (AI-generated) media.
  - Name a Grievance Officer.
- **DPDP Act and Rules (notified November 2025):** most duties start by **May 2027**: consent notices, parental consent for under-18s, breach notification within 72 hours, and logs kept for one year. Separately, cyber incidents must be reported to CERT-In within 6 hours.
- **Copyright:** the uploader keeps ownership. They give the platform a non-exclusive licence to host and preview. Each buyer gets a written licence (exclusive or non-exclusive).
- **People in footage:**
  - Blur victims and minors.
  - Ban identification of sexual-assault victims and any CSAM.
  - Put a warning in front of graphic content.
  - Give anyone shown in footage a way to request takedown (the `reports` feature).

## Verification approach

1. **Provenance:** C2PA Content Credentials via `c2pa-python`. A valid manifest is a strong positive signal. A missing one is normal and neutral: Pixel phones sign photos; Samsung signs only AI-edited images; iPhones don't use C2PA.
2. **Metadata:** EXIF for photos, `ffprobe` tags for videos (creation time, GPS, device, encoder). WhatsApp and Signal strip metadata, so missing metadata is neutral too. Ask uploaders to share the original from their gallery.
3. **AI-likelihood score:** `dima806/ai_vs_human_generated_image_detection` (Apache-2.0, commercial use allowed). Sample at most 16 frames, then take the median and the top-3 mean.
4. **Duplicates:** perceptual hash (`ImageHash` pHash) of sampled frames. A Hamming distance of 8 or less counts as a likely copy.
5. **Risk level** combines these signals. A human admin reviews every upload before it goes on sale.

## Protecting previews

- **What the preview is:**
  - Low resolution (480p).
  - At most 30 seconds.
  - A diagonal tiled watermark burned into the video.
  - AES-128 encrypted HLS.
  - Signed URLs that expire in minutes.
  - The viewer's organisation name overlaid by the player.
- **What it can't do:** no website can fully stop screen recording, since a phone camera defeats every technique. Real DRM (Widevine/FairPlay) needs a paid licence vendor.
- **The real protection:** the preview is low quality and the original never leaves the server before payment. Visible buyer marks make leaks traceable, and the terms of service carry penalties.

## Trending score

Uploads are clustered into incidents by geohash (precision 6, about 1.2 × 0.6 km, including neighbouring cells) within a 2-hour window.

**Score** = (3 × distinct uploaders + uploads + 0.5 × channel views + verification bonus) / (hours since first upload + 2)^1.8

This is the Hacker News gravity formula: new, widely witnessed incidents rise; old ones sink. Uploaders are counted as distinct accounts, so one person cannot inflate a cluster.
