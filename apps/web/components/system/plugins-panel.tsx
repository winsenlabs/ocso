import { DataTable } from '@/components/ui/data-table';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import type { PluginInfo } from '@/lib/api/plugins';
import { contributionLines, pluginCount } from '@/lib/plugins';

/**
 * Plugins (docs/guides/extending/install-a-plugin.md): what this deployment runs. First-party
 * plugins ship with OCSO; installed ones were added by the operator through
 * OCSO_PLUGINS at a pinned version and run in-process with full trust.
 */
export function PluginsPanel({ plugins }: { plugins: PluginInfo[] | null }) {
  if (!plugins) {
    return (
      <section className="ch" aria-label="Plugins">
        <div className="t">
          <h3>Plugins</h3>
        </div>
        <p className="mono-sm" style={{ margin: 0 }}>
          The plugin list could not be loaded.
        </p>
      </section>
    );
  }
  return (
    <>
      <SecHead id="plugins" title="Plugins" count={pluginCount(plugins)} desc="Installed plugins run inside OCSO with full access; the api and worker load the same list at start-up." />
      <DataTable
        label="Plugins"
        template="minmax(0,1.2fr) 120px 110px minmax(0,1.6fr)"
        rows={plugins}
        rowKey={(p) => p.name}
        columns={[
          { key: 'name', header: 'Plugin', cell: (p) => <b style={{ fontSize: 12.5 }}>{p.name}</b> },
          { key: 'version', header: 'Version', cell: (p) => <span className="mono">{p.version}</span> },
          {
            key: 'source',
            header: 'Source',
            cell: (p) => (
              <StatusChip tone={p.source === 'installed' ? 'accent' : 'muted'} title={p.source === 'installed' ? 'Installed through OCSO_PLUGINS' : 'Ships with OCSO'}>
                {p.source}
              </StatusChip>
            ),
          },
          {
            key: 'contributes',
            header: 'Contributes',
            cell: (p) =>
              contributionLines(p).map((line) => (
                <span key={line} className="mono-sm" style={{ display: 'block' }}>
                  {line}
                </span>
              )),
          },
        ]}
      />
    </>
  );
}
