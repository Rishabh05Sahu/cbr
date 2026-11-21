import type { Metadata } from 'next';
import { CONTACT_EMAIL } from '@/lib/contact';

export const metadata: Metadata = { title: 'Delete your account · CBR Property CRM' };

export default function AccountDeletionPage() {
  return (
    <>
      <h1>Delete your CBR CRM account</h1>
      <p>
        This page explains how to delete your account for CBR Property CRM (the website and the
        &ldquo;CBR CRM&rdquo; Android app by Crystal Bricks &amp; Roofs).
      </p>

      <h2>How to ask</h2>
      <ul>
        <li>
          Email{' '}
          <a href={`mailto:${CONTACT_EMAIL}?subject=Delete%20my%20account`}>{CONTACT_EMAIL}</a> from
          the email address you sign in with, with the subject &ldquo;Delete my account&rdquo;.
        </li>
        <li>Or ask the Owner or Admin of your organisation to remove you.</li>
      </ul>
      <p>We confirm by email and complete the request within 30 days.</p>

      <h2>What is deleted</h2>
      <ul>
        <li>Your sign-in (email and password), your sessions and your authenticator settings.</li>
        <li>Your profile details (name and any HR details) and your notification settings.</li>
      </ul>

      <h2>What is kept</h2>
      <ul>
        <li>
          Business records you created for your organisation (leads, notes, logged calls, tasks and
          visits) belong to the organisation and stay with it, reassigned to a colleague.
        </li>
        <li>
          Security and audit records are kept as long as needed for security and legal obligations,
          then deleted.
        </li>
      </ul>
    </>
  );
}
