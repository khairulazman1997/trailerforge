import { useState } from 'react';
import { useAppState, useStore } from '../app-context.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { EditableText } from '../components/EditableText.js';
import { Link, navigate, projectPath, type ProjectTab } from '../router.js';
import { BriefPage } from './Brief.js';
import { CapturePage } from './Capture.js';
import { CutPage } from './Cut.js';
import { FootagePage } from './Footage.js';
import { KnowledgePage } from './Knowledge.js';
import { BrandPage } from './Brand.js';
import { StoryboardPage } from './Storyboard.js';
import { VersionsPage } from './Versions.js';
import { busyTask } from '../store.js';

const TAB_LABEL: Record<ProjectTab, string> = {
  overview: 'Overview',
  brief: 'Brief',
  knowledge: 'Game knowledge',
  storyboard: 'Storyboard',
  capture: 'Capture',
  footage: 'Footage',
  cut: 'Cut',
  variants: 'Versions',
  brand: 'Brand',
};

export function ProjectPage({ id, tab }: { id: string; tab: ProjectTab }) {
  const view = useAppState((s) => s.projects[id]);
  const busy = useAppState((s) => busyTask(s, id));
  if (!view) {
    return (
      <main className="page">
        <h1>Project not open</h1>
        <p>
          This project is not open in the engine. <Link to="/">Go to projects</Link> to open it.
        </p>
      </main>
    );
  }
  return (
    <main className="page">
      <nav className="tabs" aria-label="Project sections">
        {(Object.keys(TAB_LABEL) as ProjectTab[]).map((t) => (
          <Link key={t} to={projectPath(id, t)} aria-current={t === tab ? 'page' : undefined}>
            {TAB_LABEL[t]}
          </Link>
        ))}
      </nav>
      {busy && (
        <p className="banner" role="status">
          Working: {busy.kind}… editing is paused for this project.
        </p>
      )}
      {tab === 'overview' ? (
        <Overview id={id} />
      ) : tab === 'brief' ? (
        <BriefPage id={id} />
      ) : tab === 'knowledge' ? (
        <KnowledgePage id={id} />
      ) : tab === 'storyboard' ? (
        <StoryboardPage id={id} />
      ) : tab === 'capture' ? (
        <CapturePage id={id} />
      ) : tab === 'footage' ? (
        <FootagePage id={id} />
      ) : tab === 'cut' ? (
        <CutPage id={id} />
      ) : tab === 'variants' ? (
        <VersionsPage id={id} />
      ) : tab === 'brand' ? (
        <BrandPage id={id} />
      ) : (
        <Placeholder tab={tab} />
      )}
    </main>
  );
}

function Overview({ id }: { id: string }) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const busy = useAppState((s) => busyTask(s, id));
  const [confirmClose, setConfirmClose] = useState(false);
  const p = view.project;
  const slots = p.storyboard?.sections.reduce((n, s) => n + s.slots.length, 0) ?? 0;

  return (
    <>
      <h1>
        <EditableText
          label="Project name"
          value={p.name}
          onCommit={(name) => void store.command(id, 'core/project.rename', { name })}
          className="title"
        />
      </h1>
      <p className="muted">{view.dir}</p>

      <dl className="facts" aria-label="Project state">
        <div>
          <dt>Status</dt>
          <dd>{p.status}</dd>
        </div>
        <div>
          <dt>Video type</dt>
          <dd>{p.brief.videoTypeId ?? 'not chosen'}</dd>
        </div>
        <div>
          <dt>Output formats</dt>
          <dd>{p.formatTargets.length}</dd>
        </div>
        <div>
          <dt>Game facts</dt>
          <dd>{p.knowledge.length}</dd>
        </div>
        <div>
          <dt>Storyboard slots</dt>
          <dd>{slots}</dd>
        </div>
        <div>
          <dt>Changes this session</dt>
          <dd data-testid="project-version">{view.version}</dd>
        </div>
      </dl>

      <div className="row">
        <button
          type="button"
          disabled={!view.canUndo || !!busy}
          onClick={() => void store.undo(id)}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!view.canRedo || !!busy}
          onClick={() => void store.redo(id)}
        >
          Redo
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="danger"
          disabled={!!busy}
          onClick={() => setConfirmClose(true)}
        >
          Close project
        </button>
      </div>

      <ConfirmDialog
        open={confirmClose}
        title="Close this project?"
        confirmLabel="Close project"
        tone="danger"
        onCancel={() => setConfirmClose(false)}
        onConfirm={async () => {
          if (await store.closeProject(id)) navigate('/');
          setConfirmClose(false);
        }}
      >
        <p>
          Your changes are already saved. Closing releases the project so another window or tool can
          open it.
        </p>
      </ConfirmDialog>
    </>
  );
}

function Placeholder({ tab }: { tab: ProjectTab }) {
  return (
    <>
      <h1>{TAB_LABEL[tab]}</h1>
      <p className="muted">
        This screen is not built yet. The data behind it is already available through the engine.
      </p>
    </>
  );
}
