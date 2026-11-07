'use client';
import { useRouter } from 'next/navigation';
import { Button } from './ui';
import { authClient } from '@/platform/auth/client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      onClick={async () => {
        await authClient.signOut();
        router.push('/login?notice=signed-out');
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
