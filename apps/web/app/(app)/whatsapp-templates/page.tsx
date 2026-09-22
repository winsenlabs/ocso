import type { Metadata } from 'next';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { TemplatesBody } from '@/components/templates/templates-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/templates.css';

export const metadata: Metadata = { title: 'WhatsApp templates' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search templates" />
      <PageHead
        title="WhatsApp templates"
        sub="Pre-approved messages: the only way to reach a customer 24 hours after their last message. Write one, submit it for WhatsApp’s review, and execs can send it from the conversation once approved."
      />
      <PageBody>
        <TemplatesBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
