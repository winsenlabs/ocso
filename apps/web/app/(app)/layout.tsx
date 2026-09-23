import { Suspense, type ReactNode } from 'react';
import { AskOcsoProvider } from '@/components/shell/ask-ocso-context';
import { SidebarFallback } from '@/components/shell/shell-fallback';
import { ShellSidebar } from '@/components/shell/shell-sidebar';
import { TemplateNoticesSlot } from '@/components/templates/template-notices-slot';

/**
 * Authenticated app frame: sidebar + main. Only the sidebar reads the session
 * here (behind its own Suspense); pages sit beside it and stream behind
 * loading.tsx, so neither blocks the other (cacheComponents).
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AskOcsoProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="app">
        <Suspense fallback={<SidebarFallback />}>
          <ShellSidebar />
        </Suspense>
        <main className="main shell" id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
      {/* WhatsApp template review results for their submitter (docs/07 §3). */}
      <Suspense fallback={null}>
        <TemplateNoticesSlot />
      </Suspense>
    </AskOcsoProvider>
  );
}
