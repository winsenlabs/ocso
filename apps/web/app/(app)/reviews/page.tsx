import type { Metadata } from 'next';
import type { SearchParams } from '@/components/analytics/params';
import { ReviewsBody } from '@/components/quality/reviews-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/ops.css';

export const metadata: Metadata = { title: 'Reviews' };

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search reviews" />
      <PageHead title="Reviews" sub="Quality review of AI and human handling, conversation by conversation, against an explicit rubric." />
      <PageBody>
        <ReviewsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
