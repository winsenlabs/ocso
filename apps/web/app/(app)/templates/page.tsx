import type { Metadata } from 'next';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { TemplatesBody } from '@/components/templates/templates-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/templates.css';

export const metadata: Metadata = { title: 'Message templates' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search templates" />
      <PageHead
        title="Message templates"
        sub="Pre-approved messages for channels with a reply window (e.g. WhatsApp, 24 hours after the customer’s last message): the only way to reach a customer once it closes. Write one, submit it for the provider’s review, and execs can send it from the conversation once approved."
      />
      <PageBody>
        <TemplatesBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
