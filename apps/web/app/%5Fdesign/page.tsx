import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ChipsPreview } from '@/components/design-preview/chips-preview';
import { ConfigPreview } from '@/components/design-preview/config-preview';
import { ConversationPreview } from '@/components/design-preview/conversation-preview';
import { DataPreview } from '@/components/design-preview/data-preview';
import { LayoutPreview } from '@/components/design-preview/layout-preview';
import { OverlayPreview } from '@/components/design-preview/overlay-preview';
import { SidebarPreview } from '@/components/design-preview/sidebar-preview';
import { ThemeToggle } from '@/components/shell/theme-toggle';

export const metadata: Metadata = { title: 'Design primitives' };

/**
 * /_design — internal preview of every primitive in each state, for visual
 * comparison against design/*.dc.html. Not served in production builds.
 * (Folder is %5Fdesign because `_folders` are private in the App Router.)
 */
export default function DesignPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <main className="main" style={{ maxWidth: 1180, margin: '0 auto', padding: '32px 32px 80px' }}>
      <div className="page-head-row">
        <div className="page-head">
          <h1>Design primitives</h1>
          <p className="page-sub">components/ui rendered in each state · compare with design/*.dc.html</p>
        </div>
        <div className="page-head-actions">
          <ThemeToggle />
        </div>
      </div>
      <SidebarPreview />
      <ChipsPreview />
      <DataPreview />
      <LayoutPreview />
      <ConversationPreview />
      <ConfigPreview />
      <OverlayPreview />
    </main>
  );
}
