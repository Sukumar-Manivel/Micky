import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, LegalSection } from '@/components/legal-page';

export const metadata: Metadata = { title: 'Terms' };

// A static Server Component: prerendered at build time, no client JavaScript.
export default function TermsPage() {
  return (
    <LegalPage title="Terms" intro="How Micky works for witnesses who upload footage and for newsrooms that license it.">
      <LegalSection id="uploaders" title="If you upload footage">
        <ul>
          <li>You must have recorded it yourself, and it must be real and not edited to mislead.</li>
          <li>You keep the copyright. You allow Micky to store the file, check it, and show approved newsrooms a small, watermarked preview.</li>
          <li>Every upload is checked by software and reviewed by a person before it goes on sale. We may refuse any upload.</li>
          <li>When a newsroom buys a licence, you earn your share of the price, shown in your Earnings page. Payouts go to your UPI ID.</li>
          <li>You can remove an upload until someone has bought a licence for it.</li>
        </ul>
      </LegalSection>

      <LegalSection id="licence" title="Licences for newsrooms">
        <ul>
          <li>Only newsrooms we have approved can see previews and buy licences.</li>
          <li>
            <strong>Non-exclusive licence:</strong> you may broadcast, stream and publish the footage in news coverage,
            worldwide and without a time limit. Other newsrooms may license it too.
          </li>
          <li>
            <strong>Exclusive licence:</strong> the same rights, and no other newsroom can buy it after you. It can only be
            bought before anyone else has licensed the footage.
          </li>
          <li>Previews are for evaluation only. Do not record, publish or share them.</li>
        </ul>
      </LegalSection>

      <LegalSection id="rules" title="What is not allowed">
        <ul>
          <li>Sexual content, and any content involving the sexual abuse of children.</li>
          <li>Footage that identifies a victim of sexual assault, or close-ups of injured or dead people.</li>
          <li>Footage that identifies children, unless it is clearly in the public interest and blurred.</li>
          <li>AI-generated or manipulated footage presented as real.</li>
        </ul>
        <p>Help first, film only if safe. Never get in the way of police, fire or ambulance crews.</p>
      </LegalSection>

      <LegalSection id="takedown" title="Complaints and takedowns">
        <p>
          Anyone, including people shown in footage, can ask us to review or remove it through the{' '}
          <Link href="/report" className="font-semibold underline">
            Report content
          </Link>{' '}
          page. A person reviews every report. We act on court and government orders within the time the law requires.
        </p>
      </LegalSection>

      <LegalSection id="payments" title="Payments">
        <p>
          Newsrooms pay through Razorpay; card and UPI details are entered on Razorpay’s own page, never on ours. Prices are
          in Indian rupees and include Micky’s platform fee.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
