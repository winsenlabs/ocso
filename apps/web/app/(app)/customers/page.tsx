import type { Metadata } from 'next';
import type { SearchParams } from '@/components/analytics/params';
import { CustomersBody } from '@/components/customers/customers-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/ops.css';

export const metadata: Metadata = { title: 'Customers' };

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search customers" />
      <PageHead title="Customers" sub="Customer profiles, their identities across channels, conversations and the context agents see." />
      <PageBody>
        <CustomersBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
