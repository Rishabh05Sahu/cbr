// The CBR brand: the emblem from the Crystal Bricks & Roofs logo and the product wordmark.
// The images are pre-sized in public/brand (no runtime image optimisation needed).
import Image from 'next/image';

export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <Image
      src="/brand/cbr-mark.webp"
      width={size}
      height={size}
      alt=""
      unoptimized
      priority
      className="shrink-0 rounded-full bg-[#f3f1e6] ring-1 ring-gold-300"
    />
  );
}

export function Wordmark({ tagline = true }: { tagline?: boolean }) {
  return (
    <span className="flex flex-col leading-none">
      <span className="font-display text-lg font-semibold tracking-wide text-blue-900">
        CBR Property CRM
      </span>
      {tagline && (
        <span className="mt-1 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-gold-600">
          Crystal Bricks &amp; Roofs
        </span>
      )}
    </span>
  );
}

/** The full logo (sign-in pages). */
export function BrandLogo({ size = 160 }: { size?: number }) {
  return (
    <Image
      src="/brand/cbr-logo.webp"
      width={size}
      height={size}
      alt="Crystal Bricks & Roofs"
      unoptimized
      priority
      className="mx-auto rounded-2xl bg-[#f3f1e6] shadow-sm ring-1 ring-gold-300"
    />
  );
}
