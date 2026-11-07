import { LoginForm } from './login-form';

const NOTICES: Record<string, string> = {
  reset: 'Password changed. Please sign in with your new password.',
  verified: 'Email confirmed. Please sign in.',
  'signed-out': 'You have been signed out.',
};

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const sp = await searchParams;
  const next = typeof sp.next === 'string' ? sp.next : undefined;
  const notice = typeof sp.notice === 'string' ? NOTICES[sp.notice] : undefined;
  return <LoginForm next={next} notice={notice} />;
}
