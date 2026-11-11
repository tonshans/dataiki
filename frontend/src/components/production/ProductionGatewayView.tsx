import {
  CalendarClock,
  KeyRound,
  Package,
  Plug,
  Settings,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api/client';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { ProductionNavSection } from '../../types/dataiki';
import { ApiKeysSecurityTab } from './ApiKeysSecurityTab';
import { CustomApiBuilderTab } from './CustomApiBuilderTab';
import { FreestyleScriptLabTab } from './FreestyleScriptLabTab';
import { JobScriptEditorTab } from './JobScriptEditorTab';
import { ModelRegistryTab } from './ModelRegistryTab';
import { SchedulerWorkspace } from './SchedulerWorkspace';

interface ProductionSection {
  key: ProductionNavSection;
  label: string;
  hint: string;
  icon: LucideIcon;
}

const PRODUCTION_SECTIONS: ProductionSection[] = [
  {
    key: 'models',
    label: 'Model Registry & Versioning',
    hint: 'Active, staged & archived model versions',
    icon: Package,
  },
  {
    key: 'api_builder',
    label: 'Custom REST API Builder',
    hint: 'Dynamic endpoints & built-in tester',
    icon: Plug,
  },
  {
    key: 'job_editor',
    label: 'Job Script Editor',
    hint: '5-carriage batch runner & console',
    icon: Settings,
  },
  {
    key: 'script_lab',
    label: 'Freestyle Script Editor',
    hint: 'Free-form Python, run & schedule',
    icon: Terminal,
  },
  {
    key: 'scheduler',
    label: 'Scheduler & Logs',
    hint: 'Human-friendly schedules & history',
    icon: CalendarClock,
  },
  {
    key: 'api_keys',
    label: 'API Keys & Security',
    hint: 'Static master keys for production',
    icon: KeyRound,
  },
];

// One tab per section today; the wrapper is ready for future sub-menus.
const SECTION_TABS: Record<ProductionNavSection, Array<{ key: string; label: string }>> = {
  models: [{ key: 'registry', label: 'Model Registry' }],
  api_builder: [{ key: 'endpoints', label: 'REST API Endpoints' }],
  job_editor: [{ key: 'jobs', label: 'Batch Jobs' }],
  script_lab: [{ key: 'scripts', label: 'Python Scripts' }],
  scheduler: [{ key: 'schedules', label: 'Schedules & Execution Logs' }],
  api_keys: [{ key: 'master-keys', label: 'Master API Keys' }],
};

const CARD_CLASS =
  'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]';

function sectionContent(section: ProductionNavSection, allowFreestyle: boolean) {
  switch (section) {
    case 'models':
      return <ModelRegistryTab />;
    case 'api_builder':
      return <CustomApiBuilderTab />;
    case 'job_editor':
      return <JobScriptEditorTab />;
    case 'script_lab':
      return allowFreestyle ? <FreestyleScriptLabTab /> : null;
    case 'scheduler':
      return <SchedulerWorkspace allowFreestyle={allowFreestyle} />;
    case 'api_keys':
      return <ApiKeysSecurityTab />;
    default:
      return null;
  }
}

export function ProductionGatewayView() {
  const prodNavSection = useUIStore((state) => state.prodNavSection);
  const setProdNavSection = useUIStore((state) => state.setProdNavSection);
  const activeProjectKey = usePipelineStore((state) => state.activeProjectKey);
  const [allowFreestyle, setAllowFreestyle] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void api
      .fetchFeatureFlags()
      .then((flags) => {
        if (!cancelled) setAllowFreestyle(Boolean(flags.allow_freestyle));
      })
      .catch(() => {
        // Keep the editor visible when the flag endpoint is unreachable (backend default is on).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = useMemo(
    () => (allowFreestyle ? PRODUCTION_SECTIONS : PRODUCTION_SECTIONS.filter((s) => s.key !== 'script_lab')),
    [allowFreestyle],
  );

  const activeSection = sections.find((section) => section.key === prodNavSection) ?? sections[0];
  const tabs = SECTION_TABS[activeSection.key];

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[248px] shrink-0 flex-col border-r-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)]">
        <div className="border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-3">
          <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
            Control Room
          </p>
          <h1 className="mt-0.5 break-words text-sm font-bold uppercase tracking-wide text-[var(--text-main)]">
            Production Gateway
          </h1>
        </div>

        <nav
          aria-label="Production Gateway sections"
          className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2"
        >
          {sections.map((section) => {
            const Icon = section.icon;
            const active = section.key === activeSection.key;
            return (
              <button
                key={section.key}
                type="button"
                onClick={() => setProdNavSection(section.key)}
                aria-current={active ? 'page' : undefined}
                className={`flex w-full items-start gap-2 border-[length:var(--border-width)] px-2 py-2 text-left rounded-[var(--border-radius)] transition-colors ${
                  active
                    ? 'border-[var(--accent-primary)] bg-[var(--bg-canvas)] text-[var(--accent-primary)]'
                    : 'border-transparent text-[var(--text-main)] hover:border-[var(--border-color)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Icon size={15} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block break-words text-[11px] font-bold">
                    {section.label}
                  </span>
                  <span
                    className={`mt-0.5 block break-words text-[9px] leading-relaxed ${
                      active ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'
                    }`}
                  >
                    {section.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="border-t-[length:var(--border-width)] border-[var(--border-color)] px-3 py-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
            Active Project
          </p>
          <p className="mt-0.5 break-all font-mono text-[10px] text-[var(--text-main)]">
            {activeProjectKey || 'No project selected'}
          </p>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg-canvas)]">
        <div className="shrink-0 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2">
          <div
            role="tablist"
            aria-label={`${activeSection.label} sub-tabs`}
            className="flex flex-wrap items-center gap-1"
          >
            {tabs.map((tab, index) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={index === 0}
                className={`border-[length:var(--border-width)] px-2.5 py-1.5 text-[10px] font-bold rounded-[var(--border-radius)] transition-colors ${
                  index === 0
                    ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--bg-card)]'
                    : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {activeProjectKey ? (
            sectionContent(activeSection.key, allowFreestyle)
          ) : (
            <div className={`${CARD_CLASS} mx-auto mt-6 max-w-lg px-5 py-8 text-center`}>
              <Package size={24} className="mx-auto text-[var(--text-muted)]" />
              <h2 className="mt-2 text-sm font-bold text-[var(--text-main)]">
                Select a project first
              </h2>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
                Open the Project Manager from the top navigation bar and choose a project
                before using the Production Gateway.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
