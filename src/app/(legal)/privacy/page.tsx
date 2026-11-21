import type { Metadata } from 'next';
import { CONTACT_EMAIL } from '@/lib/contact';

export const metadata: Metadata = { title: 'Privacy policy · CBR Property CRM' };

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy policy</h1>
      <p className="text-sm text-slate-500">Last updated 22 November 2026</p>

      <p>
        CBR Property CRM (the website at crm.crystalbricksroofs.com and the &ldquo;CBR CRM&rdquo;
        Android app) is the customer-relationship system of Crystal Bricks &amp; Roofs, a real
        estate business in Dubai. It is used only by the staff of the organisations that use it.
        Accounts are created by invitation; the public cannot sign up.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your account:</strong> your name, work email address, role, and, if your
          organisation records them, HR details such as a phone number.
        </li>
        <li>
          <strong>Business records you work with:</strong> enquiries (leads) and their contact
          details (name, phone, email), property requirements, notes, call and message outcomes you
          log, tasks, site visits and property listings.
        </li>
        <li>
          <strong>Security and audit records:</strong> sign-in events, the IP address of requests,
          and a log of important changes (for example a phone number being revealed).
        </li>
      </ul>

      <h2>What the app does not do</h2>
      <ul>
        <li>It does not read your call log, contacts, SMS, location, camera or files.</li>
        <li>
          When you tap Call or WhatsApp, the app opens your phone&rsquo;s dialer or WhatsApp. We
          record only that you tapped it; the outcome is what you choose to log.
        </li>
        <li>There is no advertising and no tracking for advertising.</li>
        <li>We do not sell personal data or share it for marketing.</li>
      </ul>

      <h2>How we use it</h2>
      <p>
        Only to run the CRM for your organisation: showing your leads and tasks, recording what
        happened, reports for managers, reminders and notifications, and keeping accounts secure
        (two-step verification, rate limits and audit logs).
      </p>

      <h2>Who can see it</h2>
      <p>
        People in your organisation, according to their role (for example, a sales executive sees
        only their own leads). Data of one organisation is never visible to another. Platform
        support can view an organisation&rsquo;s data only after its Owner approves a time-limited
        request, and every such view is recorded.
      </p>
      <p>
        We use service providers to run the system: Amazon Web Services (servers), Supabase
        (database and file storage) and Google Workspace (email). They process data only on our
        instructions.
      </p>

      <h2>Security</h2>
      <p>
        All traffic is encrypted (HTTPS). Passwords are stored only as secure hashes. Owners and
        Admins must use two-step verification. On the phone, the sign-in token is kept in
        Android&rsquo;s encrypted storage, and screenshots of the app are blocked.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Account data is kept while the account is active. Business records belong to the
        organisation that created them and are kept while it uses the CRM. Security and audit
        records are kept as long as needed for security and legal obligations.
      </p>

      <h2>Your choices</h2>
      <p>
        You can ask for a copy of your personal data, a correction, or the deletion of your account.
        See <a href="/account-deletion">how to delete your account</a>, or email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Crystal Bricks &amp; Roofs, Dubai · <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </>
  );
}
