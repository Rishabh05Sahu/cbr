import { Card, PageHeader } from '@/components/ui';

export default function Loading() {
  return (
    <>
      <PageHeader title="Calendar" />
      <Card>
        <p role="status" className="text-sm text-slate-500">
          Loading your calendar…
        </p>
      </Card>
    </>
  );
}
