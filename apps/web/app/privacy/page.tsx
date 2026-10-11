import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, LegalSection } from '@/components/legal-page';

export const metadata: Metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" intro="What we collect, who can see it, and how to ask us to change or delete it.">
      <LegalSection id="collect" title="What we collect">
        <ul>
          <li>Your account: name, email address and password (stored only as a secure hash).</li>
          <li>For newsrooms: the organisation’s name and website.</li>
          <li>For witnesses: your UPI ID, so we can pay you.</li>
          <li>
            The files you upload and the details inside them, such as the place and time they were recorded, and the
            location you enter. We use these to check the footage is genuine.
          </li>
          <li>Records of purchases and payouts, which the law requires us to keep.</li>
        </ul>
      </LegalSection>

      <LegalSection id="who" title="Who sees what">
        <ul>
          <li>
            Newsrooms never see a witness’s name, email or UPI ID. Before buying, they see a short, low-resolution,
            watermarked preview, the place and time it was recorded, and our checks.
          </li>
          <li>
            The place newsrooms see is rounded to about 100 metres, so it shows the street, not the spot where you stood.
            Only you and Micky reviewers see the exact point.
          </li>
          <li>
            When a newsroom buys a licence, it downloads the full-quality footage with the identifying details inside the
            file removed: GPS location, phone make, model and serial number, owner or artist names, comments and similar
            tags. The recording time is kept, because newsrooms need it. The untouched file you uploaded stays with
            Micky, where only reviewers can see it, as evidence in case of a dispute.
          </li>
          <li>
            Removing file details does not hide what the footage itself shows or says. If faces, voices, number plates or
            your surroundings could identify you, think about that before uploading.
          </li>
          <li>
            A newsroom’s name and a short account code are drawn into the picture of every preview it watches, so a
            recording of a preview shows who made it. Witnesses also see which newsroom bought their footage.
          </li>
          <li>Micky reviewers can see uploads and their full technical details to check them.</li>
          <li>Payment details are handled by Razorpay. We never see card numbers.</li>
        </ul>
      </LegalSection>

      <LegalSection id="device" title="On your device">
        <p>
          We keep you logged in with one secure cookie that scripts cannot read. We do not use advertising or tracking
          cookies, and our fonts and maps load without third-party trackers (map tiles come from OpenStreetMap).
        </p>
      </LegalSection>

      <LegalSection id="rights" title="Your choices">
        <p>
          You can ask to see, correct or delete your data. If you are shown in footage on Micky and want it reviewed or
          removed, use the{' '}
          <Link href="/report" className="font-semibold underline">
            Report content
          </Link>{' '}
          page; you do not need an account.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
