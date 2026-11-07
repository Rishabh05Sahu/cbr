'use client';
import { Alert, Button } from '@/components/ui';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-4">
      <Alert tone="error">
        Something went wrong while loading this page.
        {error.digest ? ` Reference: ${error.digest}.` : ''}
      </Alert>
      <Button variant="secondary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
