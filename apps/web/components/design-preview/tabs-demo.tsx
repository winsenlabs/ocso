'use client';

import { useState } from 'react';
import { TabPanel, Tabs } from '@/components/ui/tabs';

const ITEMS = ['overview', 'prompt', 'tools', 'channels', 'routing', 'escalation', 'analytics', 'versions'].map((k) => ({
  key: k,
  label: k.charAt(0).toUpperCase() + k.slice(1),
}));

/** Button-mode Tabs with local state (arrow keys move focus). */
export function TabsDemo() {
  const [active, setActive] = useState('overview');
  return (
    <div>
      <Tabs
        label="Agent sections"
        idBase="demo"
        items={ITEMS}
        active={active}
        onSelect={setActive}
        trailing={
          <button type="button" className="btn tiny ghost">
            Duplicate agent
          </button>
        }
      />
      <TabPanel idBase="demo" active={active}>
        <span className="mono-sm">selected: {active}</span>
      </TabPanel>
    </div>
  );
}
