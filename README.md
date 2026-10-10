# FirstFrame

**A marketplace connecting eyewitness footage from the public with news channels.**

When an incident happens — a fire, an accident, a flood — reporters usually arrive after it is over. The best footage is on bystanders' phones, and newsrooms have no easy way to reach it. FirstFrame lets the public upload verified photos and videos of incidents, and lets news channels discover, preview and license them, with the uploader getting paid for every sale.

> Status: 🚧 In active development. See the [roadmap](#roadmap).

---

## How it works

1. **A witness uploads** a photo or video with its location and time from their phone.
2. **The platform verifies it** — metadata checks, an AI-generated-content score, and admin review.
3. **A protected preview is created** — low resolution, watermarked, streamed only. The original file is never exposed.
4. **News channels browse** incidents by location, time and trend, and get live alerts for new footage.
5. **A channel buys a license**, receives a time-limited download link to the original, and the uploader earns their share.

## User roles

| Role | What they can do |
|---|---|
| **Uploader (public)** | Upload footage, track review status, see sales and earnings, withdraw payouts |
| **News channel** | Browse and preview footage, get live incident alerts, buy licenses, download originals |
| **Admin** | Review and approve uploads, handle reports and disputes |

## Architecture

```
 Uploader PWA        News channel portal
        \                 /
         Cloudflare (DNS, SSL, CDN, frontend hosting)
                  |
     Server (Docker Compose)
     ├── API server        (NestJS)
     ├── Processing worker (FFmpeg, BullMQ)
     ├── Verification svc  (Python, FastAPI)
     ├── PostgreSQL        (main data)
     └── Redis             (job queue)
                  |
     Object storage (Cloudflare R2)      Payments (Razorpay)
```

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, TypeScript, Tailwind CSS (installable PWA) |
| Backend API | Node.js, NestJS, TypeScript |
| Database | PostgreSQL with Prisma ORM |
| Background jobs | Redis, BullMQ |
| Video processing | FFmpeg (compression, watermarking, previews) |
| Verification | Python, FastAPI |
| Storage | Cloudflare R2 (S3-compatible); MinIO for local development |
| Realtime | Socket.IO, Web Push |
| Payments | Razorpay |
| Infrastructure | Docker, Docker Compose, Caddy, GitHub Actions |

## Roadmap

- [ ] **M0** Project setup, repository structure, local PostgreSQL in Docker
- [ ] **M1** Authentication with roles (uploader, channel, admin)
- [ ] **M2** Footage upload with location and time
- [ ] **M3** Background processing: watermarked low-resolution previews
- [ ] **M4** Channel portal: browse and filter footage by location and time
- [ ] **M5** Purchase and secure download (Razorpay test mode)
- [ ] **M6** Dashboards for uploaders, channels and admins
- [ ] **M7** Verification: metadata checks and AI-generated-content scoring
- [ ] **M8** Live incident alerts and trending ranking
- [ ] **M9** Deployment with CI/CD
- [ ] **M10** Tests, documentation and demo video

## Getting started

Setup instructions will be added as the services are built.

## Author

**Your Name** — [GitHub](https://github.com/your-username) · [LinkedIn](https://linkedin.com/in/your-profile)
