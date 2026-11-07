import { Card, PageHeader } from '@/components/ui';

export default function Loading() {
  return (
    <>
      <PageHeader title="My Day" />
      <Card>
        <p role="status" className="text-sm text-slate-500">
          Loading your follow-ups…
        </p>
      </Card>
    </>
  );
}
