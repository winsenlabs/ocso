import { BrandMark } from '@/components/ui/brand-mark';

/** Static sidebar shown while the session loads (part of the prerendered shell). */
export function SidebarFallback() {
  return (
    <aside className="sidebar" aria-label="OCSO" aria-busy="true">
      <div className="sb-brand">
        <div className="a-mark">
          <BrandMark />
        </div>
        <div className="a-word">OCSO</div>
      </div>
      {[70, 55, 62, 48, 58].map((w) => (
        <div key={w} className="shell-skeleton" style={{ width: `${w}%` }} />
      ))}
    </aside>
  );
}
