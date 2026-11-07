import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { ProjectItem } from '../../types/dataiki';
import {
  parseProjectKey,
  UNCATEGORIZED_LABEL,
} from '../../utils/projectDelimiter';

interface ProjectEntry {
  project: ProjectItem;
  category: string;
  displayName: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectManagerModal() {
  const isOpen = useUIStore((state) => state.isProjectModalOpen);
  const setProjectModalOpen = useUIStore((state) => state.setProjectModalOpen);
  const addToast = useUIStore((state) => state.addToast);

  const projects = usePipelineStore((state) => state.projects);
  const activeProjectKey = usePipelineStore((state) => state.activeProjectKey);
  const loadProjects = usePipelineStore((state) => state.loadProjects);
  const createProjectWithCategory = usePipelineStore(
    (state) => state.createProjectWithCategory,
  );
  const setActiveProject = usePipelineStore((state) => state.setActiveProject);

  const [selectedCategory, setSelectedCategory] = useState(UNCATEGORIZED_LABEL);
  const [draftCategory, setDraftCategory] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const projectEntries = useMemo<ProjectEntry[]>(
    () =>
      projects.map((project) => {
        const parsed = parseProjectKey(project.project_key);
        return {
          project,
          category: parsed.category || UNCATEGORIZED_LABEL,
          displayName: parsed.displayName || project.display_name,
        };
      }),
    [projects],
  );

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of projectEntries) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }
    return Array.from(counts, ([name, count]) => ({ name, count })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [projectEntries]);

  const filteredProjects = useMemo(
    () =>
      projectEntries
        .filter((entry) => entry.category === selectedCategory)
        .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [projectEntries, selectedCategory],
  );

  const activeEntry = projectEntries.find(
    (entry) => entry.project.project_key === activeProjectKey,
  );

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    void loadProjects().then((loadedProjects) => {
      if (cancelled) return;
      const active = loadedProjects.find(
        (project) => project.project_key === activeProjectKey,
      );
      const category = active
        ? parseProjectKey(active.project_key).category
        : UNCATEGORIZED_LABEL;
      setSelectedCategory(category);
      setDraftCategory(category === UNCATEGORIZED_LABEL ? '' : category);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, activeProjectKey, loadProjects]);

  useEffect(() => {
    if (!isOpen) return;
    if (categories.length === 0) {
      setSelectedCategory(UNCATEGORIZED_LABEL);
      return;
    }
    if (!categories.some((category) => category.name === selectedCategory)) {
      setSelectedCategory(categories[0].name);
    }
  }, [isOpen, categories, selectedCategory]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectModalOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setProjectModalOpen]);

  if (!isOpen) return null;

  const selectCategory = (category: string) => {
    setSelectedCategory(category);
    setDraftCategory(category === UNCATEGORIZED_LABEL ? '' : category);
  };

  const openProject = async (projectKey: string) => {
    setIsBusy(true);
    try {
      await setActiveProject(projectKey);
      setProjectModalOpen(false);
    } catch (error) {
      addToast('error', `Failed to open project: ${messageOf(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draftName.trim();
    if (!name) {
      addToast('warning', 'Project name is required.');
      return;
    }

    const typedCategory = draftCategory.trim();
    if (typedCategory.includes('__')) {
      addToast('warning', 'Category cannot contain the __ delimiter.');
      return;
    }
    if (name.includes('__')) {
      addToast('warning', 'Project name cannot contain the __ delimiter.');
      return;
    }
    const category = typedCategory === UNCATEGORIZED_LABEL ? '' : typedCategory;

    setIsBusy(true);
    try {
      await createProjectWithCategory(category, name, draftDescription.trim());
      addToast('success', `Project '${name}' created.`);
      setDraftName('');
      setDraftDescription('');
      setProjectModalOpen(false);
    } catch (error) {
      addToast('error', `Failed to create project: ${messageOf(error)}`);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setProjectModalOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-manager-title"
        className="relative z-[51] flex h-[min(780px,92vh)] w-[min(1100px,94vw)] flex-col overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b-[length:var(--border-width)] border-[var(--border-color)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpen size={20} className="shrink-0 text-[var(--accent-primary)]" />
            <div className="min-w-0">
              <h2
                id="project-manager-title"
                className="text-lg font-bold text-[var(--text-main)]"
              >
                Project Manager
              </h2>
              <p className="truncate text-xs text-[var(--text-muted)]">
                Categories are parsed from the project key with the __ delimiter.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setProjectModalOpen(false)}
            className="flex h-8 w-8 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
            aria-label="Close Project Manager"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)]">
            <div className="flex shrink-0 items-center justify-between border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                Categories
              </span>
              <span className="text-[11px] font-semibold text-[var(--text-muted)]">
                {categories.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              {categories.length === 0 ? (
                <p className="px-2 py-3 text-xs text-[var(--text-muted)]">
                  No categories yet.
                </p>
              ) : (
                categories.map((category) => {
                  const isSelected = category.name === selectedCategory;
                  return (
                    <button
                      key={category.name}
                      type="button"
                      onClick={() => selectCategory(category.name)}
                      className={`flex w-full items-center justify-between gap-2 border-[length:var(--border-width)] px-2.5 py-2 text-left text-sm font-semibold transition-colors rounded-[var(--border-radius)] ${
                        isSelected
                          ? 'border-[var(--border-color)] bg-[var(--accent-primary)] text-[var(--bg-card)]'
                          : 'border-transparent bg-[var(--bg-card)] text-[var(--text-main)] hover:bg-[var(--bg-hover)]'
                      }`}
                      aria-pressed={isSelected}
                    >
                      <span className="truncate">{category.name}</span>
                      <span
                        className={`shrink-0 text-[10px] font-bold ${
                          isSelected
                            ? 'text-[var(--bg-card)]'
                            : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {category.count}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b-[length:var(--border-width)] border-[var(--border-color)] px-4 py-2.5">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-bold text-[var(--text-main)]">
                  {selectedCategory}
                </h3>
                <p className="text-xs text-[var(--text-muted)]">
                  {filteredProjects.length} project
                  {filteredProjects.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className="min-w-0 text-right">
                <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                  Active Project
                </p>
                <p className="truncate text-xs font-semibold text-[var(--accent-secondary)]">
                  {activeEntry ? activeEntry.displayName : 'None'}
                </p>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {filteredProjects.length === 0 ? (
                <div className="flex h-full min-h-[160px] flex-col items-center justify-center border-[length:var(--border-width)] border-dashed border-[var(--border-color)] p-6 text-center rounded-[var(--border-radius)]">
                  <p className="text-sm font-semibold text-[var(--text-main)]">
                    No projects in this category.
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Create one with the form below.
                  </p>
                </div>
              ) : (
                filteredProjects.map((entry) => {
                  const isActive =
                    entry.project.project_key === activeProjectKey;
                  return (
                    <button
                      key={entry.project.project_key}
                      type="button"
                      disabled={isBusy}
                      onClick={() => void openProject(entry.project.project_key)}
                      className={`w-full border-[length:var(--border-width)] px-3 py-2.5 text-left transition-colors rounded-[var(--border-radius)] disabled:cursor-not-allowed disabled:opacity-60 ${
                        isActive
                          ? 'border-[var(--accent-secondary)] bg-[var(--bg-hover)]'
                          : 'border-[var(--border-color)] bg-[var(--bg-card)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-sm font-bold text-[var(--text-main)]">
                          {entry.displayName}
                        </span>
                        {isActive && (
                          <span className="shrink-0 bg-[var(--accent-secondary)] px-2 py-0.5 text-[10px] font-bold text-[var(--bg-card)] rounded-[var(--border-radius)]">
                            OPEN
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                        {entry.project.description || entry.project.project_key}
                      </p>
                    </button>
                  );
                })
              )}
            </div>

            <form
              onSubmit={(event) => void createProject(event)}
              className="shrink-0 space-y-2 border-t-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-3"
            >
              <div className="grid grid-cols-2 gap-2">
                <label className="block min-w-0">
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                    Category
                  </span>
                  <input
                    list="dataiki-project-categories"
                    value={draftCategory}
                    onChange={(event) => setDraftCategory(event.target.value)}
                    placeholder="sales"
                    className="w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)]"
                  />
                  <datalist id="dataiki-project-categories">
                    {categories.map((category) => (
                      <option key={category.name} value={category.name} />
                    ))}
                  </datalist>
                </label>
                <label className="block min-w-0">
                  <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                    Project Name
                  </span>
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    placeholder="churn_2024"
                    className="w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)]"
                  />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                  Description
                </span>
                <input
                  value={draftDescription}
                  onChange={(event) => setDraftDescription(event.target.value)}
                  placeholder="Optional project description"
                  className="w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)]"
                />
              </label>
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 text-[11px] text-[var(--text-muted)]">
                  Empty category is saved as {UNCATEGORIZED_LABEL}.
                </p>
                <button
                  type="submit"
                  disabled={isBusy || !draftName.trim()}
                  className="shrink-0 bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isBusy ? 'Working...' : '+ Create Project'}
                </button>
              </div>
            </form>
          </section>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t-[length:var(--border-width)] border-[var(--border-color)] px-4 py-2">
          <span className="truncate text-xs text-[var(--text-muted)]">
            Click a project to open it on the canvas.
          </span>
          <button
            type="button"
            onClick={() => setProjectModalOpen(false)}
            className="shrink-0 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
