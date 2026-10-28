import { isAbsolute, relative, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CommandError, readDecisions, type ProjectStore } from '@trailerforge/core';
import {
  briefStatus,
  analyzeOp,
  captureExportOp,
  captureSettingsOp,
  captureStatusOp,
  captureTipsOp,
  captureViewOp,
  footageStatusOp,
  brandViewOp,
  createDefaultVariantsOp,
  effectsViewOp,
  templatePreviewOp,
  templatesViewOp,
  variantsViewOp,
  generateCutOp,
  matchAcceptOp,
  matchSuggestOp,
  rankTakesOp,
  exportVersionOp,
  handoffOp,
  qualityOp,
  renderDraftOp,
  reviewViewOp,
  type Progress,
  generateStoryboardOp,
  OpError,
  regenerateSectionOp,
  scanKnowledgeOp,
  type Engine,
} from '@trailerforge/engine';
import { storyboardTiming, userEditedFields } from '@trailerforge/storyboard';
import { z } from 'zod';
import { COMMAND_DESCRIPTIONS, HIDDEN_COMMANDS } from './descriptions.js';

export interface McpServerOptions {
  engine: Engine;
  /**
   * Project used when a tool call names none: a folder, or a function asked at each call (the
   * app passes "the one project open in the window").
   */
  defaultProject?: string | (() => string | undefined) | undefined;
  /**
   * Folders under which an agent may register a NEW game repo for scanning. Empty (default):
   * agents can only rescan sources the user already added with the CLI or UI.
   */
  repoRoots?: readonly string[] | undefined;
}

type Args = Record<string, unknown>;

interface ToolDef {
  tool: Tool;
  /** Tools that change the project are saved before the call returns. */
  mutates: boolean;
  run(args: Args): Promise<unknown>;
}

const PROJECT_PROP = {
  type: 'string',
  description:
    'Path of the project folder (X.tforge). Optional when the server was started with one, or when exactly one project is open in the TrailerForge app.',
};

const result = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});
const failure = (message: string, details?: unknown): CallToolResult => ({
  isError: true,
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        details === undefined ? { error: message } : { error: message, details },
      ),
    },
  ],
});

function describeError(err: unknown): CallToolResult {
  if (err instanceof CommandError)
    return failure(err.message, err.issues.length ? err.issues : undefined);
  if (err instanceof OpError) return failure(err.message, err.details);
  if (err instanceof z.ZodError) {
    return failure(
      'invalid arguments',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return failure(err instanceof Error ? err.message : String(err));
}

const inside = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object' as const,
  properties: { project: PROJECT_PROP, ...properties },
  required,
  additionalProperties: false,
});

const ReadOnly = { readOnlyHint: true } as const;

/**
 * MCP server over the engine: read tools, action tools (scan, generate, regenerate), undo/redo,
 * and one tool per registered command. Edits go through the command bus, so they are validated,
 * undoable and in version history, exactly like the CLI and the UI.
 *
 * Deliberately absent: the deep repo scan (it sends file contents to Anthropic and needs a
 * human's confirmation), and registering arbitrary new repo folders (see `repoRoots`).
 */
export function createMcpServer(opts: McpServerOptions): Server {
  const { engine } = opts;
  const repoRoots = (opts.repoRoots ?? []).map((r) => resolve(r));
  const tools = new Map<string, ToolDef>();

  const project = async (args: Args): Promise<ProjectStore> => {
    const fallback =
      typeof opts.defaultProject === 'function' ? opts.defaultProject() : opts.defaultProject;
    const dir = (typeof args.project === 'string' ? args.project : undefined) ?? fallback;
    if (!dir) {
      const open = [...engine.projects.keys()];
      throw new OpError(
        'usage',
        open.length > 1
          ? `several projects are open; pass "project", one of: ${open.join('; ')}`
          : 'no project: pass "project" (path of the .tforge folder)',
      );
    }
    return engine.openProject(dir);
  };
  const add = (def: ToolDef) => tools.set(def.tool.name, def);

  // ---------------------------------------------------------------- read tools
  add({
    mutates: false,
    tool: {
      name: 'project_summary',
      description:
        'Overview of a project: name, video type, counts, and whether undo/redo are available.',
      inputSchema: object({}),
      annotations: ReadOnly,
    },
    async run(args) {
      const store = await project(args);
      const p = store.state;
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        videoType: p.brief.videoTypeId ?? null,
        formats: p.formatTargets.length,
        storyboardSlots: p.storyboard?.sections.reduce((n, s) => n + s.slots.length, 0) ?? 0,
        knowledgeEntities: p.knowledge.length,
        sources: p.sources.map((s) => ({ id: s.id, path: s.path, lastScannedAt: s.lastScannedAt })),
        canUndo: store.canUndo,
        canRedo: store.canRedo,
      };
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'brief_get',
      description:
        'The brief (what the trailer is about) and its completeness against the video type: what is missing, what is only assumed.',
      inputSchema: object({}),
      annotations: ReadOnly,
    },
    async run(args) {
      const store = await project(args);
      return { brief: store.state.brief, status: briefStatus(engine, store) };
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'knowledge_list',
      description:
        'Game facts (levels, bosses, abilities...) and the sources they came from. Entries with excludedFromLlm are never sent to an LLM by the app.',
      inputSchema: object({
        kind: { type: 'string', description: 'Only this kind, e.g. "boss".' },
        query: { type: 'string', description: 'Only names or descriptions containing this text.' },
      }),
      annotations: ReadOnly,
    },
    async run(args) {
      const store = await project(args);
      const kind = typeof args.kind === 'string' ? args.kind : undefined;
      const query = typeof args.query === 'string' ? args.query.toLowerCase() : undefined;
      const entities = store.state.knowledge
        .filter((e) => !kind || e.kind === kind)
        .filter((e) => !query || `${e.name} ${e.description}`.toLowerCase().includes(query))
        .map((e) => ({
          id: e.id,
          kind: e.kind,
          name: e.name,
          description: e.description,
          origin: e.origin,
          confidence: e.confidence,
          excludedFromLlm: e.excludedFromLlm,
          tags: e.tags,
        }));
      return { entities, sources: store.state.sources };
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'storyboard_get',
      description:
        'The storyboard. detail "outline" (default) lists sections and slots with ids, kinds, titles, seconds, lock state and whether a slot was hand-edited; "full" returns every field. Includes timing against the target length.',
      inputSchema: object({ detail: { type: 'string', enum: ['outline', 'full'] } }),
      annotations: ReadOnly,
    },
    async run(args) {
      const store = await project(args);
      const sb = store.state.storyboard;
      if (!sb)
        throw new OpError(
          'not-found',
          'this project has no storyboard yet; use storyboard_generate',
        );
      const timing = storyboardTiming(sb);
      if (args.detail === 'full') return { storyboard: sb, timing };
      return {
        revision: sb.revision,
        meta: sb.meta,
        timing,
        sections: sb.sections.map((s) => ({
          id: s.id,
          name: s.name,
          role: s.role,
          locked: s.locked,
          slots: s.slots.map((x) => ({
            id: x.id,
            kind: x.kind,
            title: x.title,
            seconds: x.duration.ideal,
            ...(x.kind === 'card'
              ? { text: x.text }
              : { captureInstruction: x.captureInstruction }),
            entityIds: x.entityIds,
            handEdited: userEditedFields(x).length > 0,
          })),
        })),
        voLines: sb.voLines.map((v) => ({
          id: v.id,
          text: v.text,
          linkedSlotIds: v.linkedSlotIds,
        })),
        music: sb.music,
      };
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'decision_log',
      description:
        'The most recent automated decisions (storyboard generation, regeneration) with the reason given.',
      inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 100 } }),
      annotations: ReadOnly,
    },
    async run(args) {
      const store = await project(args);
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const all = await readDecisions(store.paths.decisions);
      return all.slice(-limit).map((d) => ({
        at: d.at,
        step: d.step,
        subject: d.subject,
        summary: d.summary,
        reasons: d.reasons,
      }));
    },
  });

  // ---------------------------------------------------------------- undo / redo
  for (const kind of ['undo', 'redo'] as const) {
    add({
      mutates: true,
      tool: {
        name: kind,
        description: `${kind === 'undo' ? 'Undo' : 'Redo'} the last change to the project (any change, whoever made it).`,
        inputSchema: object({}),
      },
      async run(args) {
        const store = await project(args);
        const done = kind === 'undo' ? store.undo() : store.redo();
        return { done, canUndo: store.canUndo, canRedo: store.canRedo };
      },
    });
  }

  // ---------------------------------------------------------------- actions
  add({
    mutates: true,
    tool: {
      name: 'knowledge_scan',
      description:
        'Re-scan the project\'s game repo (read-only; secrets and ignored files are never read) and merge what it finds, keeping the user\'s edits. Passing "repo" registers a new repo only if it is under a folder the user allowed; otherwise ask the user to run `tforge knowledge scan --repo` once.',
      inputSchema: object({
        repo: { type: 'string', description: 'Folder of the game repo.' },
        force: { type: 'boolean', description: 'Re-extract even if nothing changed.' },
      }),
    },
    async run(args) {
      const store = await project(args);
      const repo = typeof args.repo === 'string' ? resolve(args.repo) : undefined;
      if (
        repo &&
        !store.state.sources.some((s) => s.path === repo) &&
        !repoRoots.some((r) => inside(r, repo))
      ) {
        throw new OpError(
          'usage',
          `"${repo}" is not a known source and is not under an allowed folder. Ask the user to add it with \`tforge knowledge scan <project> --repo <path>\`, or start the MCP server with --repo-root.`,
        );
      }
      return scanKnowledgeOp(engine, store, { repo, force: args.force === true });
    },
  });

  add({
    mutates: true,
    tool: {
      name: 'storyboard_generate',
      description:
        'Generate the storyboard from the brief and game facts with the configured LLM provider (the brief and non-excluded facts are sent to it). Replaces every unlocked section; locked sections are kept. Requires a complete brief, or assume=true to proceed with logged assumptions.',
      inputSchema: object({
        duration: { type: 'number', exclusiveMinimum: 0, description: 'Target length in seconds.' },
        template: { type: 'string' },
        assume: { type: 'boolean' },
      }),
    },
    async run(args) {
      const store = await project(args);
      return generateStoryboardOp(engine, store, {
        duration: typeof args.duration === 'number' ? args.duration : undefined,
        template: typeof args.template === 'string' ? args.template : undefined,
        assume: args.assume === true,
      });
    },
  });

  add({
    mutates: true,
    tool: {
      name: 'storyboard_regenerate_section',
      description:
        'Rewrite one unlocked section in the time it has now. Slots the user edited or added by hand are kept in place unless keepEdited is false.',
      inputSchema: object(
        {
          sectionId: { type: 'string' },
          instruction: {
            type: 'string',
            description: 'What to change, e.g. "more forest, less boss".',
          },
          keepEdited: { type: 'boolean' },
        },
        ['sectionId'],
      ),
    },
    async run(args) {
      const store = await project(args);
      if (typeof args.sectionId !== 'string') throw new OpError('usage', '"sectionId" is required');
      return regenerateSectionOp(engine, store, {
        sectionId: args.sectionId,
        instruction: typeof args.instruction === 'string' ? args.instruction : undefined,
        keepEdited: typeof args.keepEdited === 'boolean' ? args.keepEdited : undefined,
      });
    },
  });

  // ---------------------------------------------------------------- footage and the rough cut
  // Importing files is deliberately not a tool: pointing the app at files is the user's choice
  // (screens, `tforge ingest`), not something an AI client should be able to do.
  add({
    mutates: false,
    tool: {
      name: 'footage_status',
      description:
        'Recordings in the library: file state, length, warnings (variable frame rate, HDR, low resolution...), whether analysed, previews, and which shots each is a take of; plus import and analysis job progress.',
      inputSchema: object({}),
    },
    async run(args) {
      return footageStatusOp(engine, await project(args));
    },
  });

  add({
    mutates: true,
    tool: {
      name: 'footage_analyze',
      description:
        'Queue local analysis (shot changes, black/flash/frozen frames, motion) for recordings not analysed yet, and the music track (beats, bars, sections). Runs on this computer in the background; watch footage_status.',
      inputSchema: object({
        assetIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these library assets.',
        },
      }),
    },
    async run(args) {
      const ids = Array.isArray(args.assetIds) ? args.assetIds.map(String) : undefined;
      return analyzeOp(engine, await project(args), ids ? { assetIds: ids } : {});
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'match_suggest',
      description:
        'Ranked suggestions for which shot each imported recording belongs to, with a reason per signal (shot code in the file name, recording order, length, session). Only a shot code is certain; confirm the rest with the user.',
      inputSchema: object({}),
    },
    async run(args) {
      return matchSuggestOp(engine, await project(args));
    },
  });

  add({
    mutates: true,
    tool: {
      name: 'match_accept',
      description:
        'Attach recordings to shots: every shot-code match and every suggestion at or above minConfidence (default high), as one undo step.',
      inputSchema: object({
        minConfidence: { type: 'string', enum: ['certain', 'high', 'medium'] },
      }),
    },
    async run(args) {
      const min = args.minConfidence;
      return matchAcceptOp(
        engine,
        await project(args),
        min === 'certain' || min === 'high' || min === 'medium' ? { minConfidence: min } : {},
      );
    },
  });

  add({
    mutates: true,
    tool: {
      name: 'take_ranking',
      description:
        "Ask the configured AI which take to use for shots with several. Sends text only (the shot's words, notes and measured numbers; never footage or frames) and asks the user first if the provider is not local. Applied as one undo step.",
      inputSchema: object({
        overwriteChosen: {
          type: 'boolean',
          description: 'Also rank shots where a take is already chosen.',
        },
      }),
    },
    async run(args) {
      return rankTakesOp(
        engine,
        await project(args),
        args.overwriteChosen === true ? { overwriteChosen: true } : {},
      );
    },
  });

  add({
    mutates: true,
    tool: {
      name: 'cut_generate',
      description:
        'Build the rough cut on the music (needs the music analysed): one take per shot, cuts a frame ahead of the beat, placeholders for shots without footage, music with a fade. Rebuilding keeps locked tracks and clips edited by hand. One undo step. Edit the result with the core_timeline_* tools.',
      inputSchema: object({
        leadFrames: {
          type: 'integer',
          minimum: 0,
          maximum: 2,
          description: 'Frames to cut ahead of the beat (default 1).',
        },
      }),
    },
    async run(args) {
      const lead = typeof args.leadFrames === 'number' ? args.leadFrames : undefined;
      return generateCutOp(engine, await project(args), lead ? { leadFrames: lead } : {});
    },
  });

  // ---------------------------------------------------------------- versions, brand, effects
  add({
    mutates: false,
    tool: {
      name: 'variants_status',
      description:
        "The versions of the trailer (aspect ratio, length) derived from the master cut: for each, its length against its target, which shots were kept, shortened or dropped and why, how each shot is reframed, and any warnings. Formats without a version are listed under 'missing'. Edit with the core_variants_* tools.",
      inputSchema: object({}),
    },
    async run(args) {
      return variantsViewOp(engine, await project(args));
    },
  });

  add({
    mutates: true,
    tool: {
      name: 'variants_create_defaults',
      description:
        "Add one version per format target that has none, at the master's length. One undo step per version.",
      inputSchema: object({}),
    },
    async run(args) {
      return createDefaultVariantsOp(await project(args));
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'brand_status',
      description:
        'The brand kit (colours, logo, fonts, text sizes) with its warnings: low contrast, missing files, fallbacks in use. Set colours and sizes with core_brand_*; importing logo and font files is not offered here (the user does it in the app or with `tforge brand`).',
      inputSchema: object({}),
    },
    async run(args) {
      return brandViewOp(await project(args));
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'effects_list',
      description:
        'Everything installed that a storyboard or cut may use: transitions and finishing effects (id, name, parameters as JSON Schema, whether it flashes), graphics templates for cards and captions, and the sound effects (generated kinds plus the files in the user folder). Use only these ids.',
      inputSchema: object({}),
    },
    async run() {
      return {
        ...(await effectsViewOp(engine)),
        templates: templatesViewOp(engine),
      };
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'template_preview',
      description:
        "One frame of a graphics template with this project's brand kit, as SVG, with warnings (text outside the safe area, shrunk to fit, too short to read, missing brand files).",
      inputSchema: object(
        {
          templateId: { type: 'string', description: 'For example core/title-card.' },
          params: {
            type: 'object',
            description: 'The template parameters; text is the main words.',
          },
          at: { type: 'number', description: 'Seconds into the item (default: the middle).' },
          seconds: {
            type: 'number',
            description: 'How long the item is on screen (default: the template length).',
          },
        },
        ['templateId'],
      ),
    },
    async run(args) {
      const r = await templatePreviewOp(engine, await project(args), {
        templateId: String(args.templateId),
        ...(args.params && typeof args.params === 'object'
          ? { params: args.params as Record<string, unknown> }
          : {}),
        ...(typeof args.at === 'number' ? { at: args.at } : {}),
        ...(typeof args.seconds === 'number' ? { seconds: args.seconds } : {}),
      });
      return r;
    },
  });

  // ---------------------------------------------------------------- capture pack
  add({
    mutates: false,
    tool: {
      name: 'capture_plan',
      description:
        'The recording checklist: shots grouped by location, setup and featured entity, each with its instruction, HUD, cut and recording length, status, notes and takes; setup hints (levels, debug commands, save files); stored tips; recording settings. Mark shots with the game-trailer_capture_* tools.',
      inputSchema: object({
        include: {
          type: 'string',
          enum: ['all', 'todo'],
          description: 'todo: only shots still to record.',
        },
      }),
    },
    async run(args) {
      return captureViewOp(engine, await project(args), {
        include: args.include === 'todo' ? 'todo' : 'all',
      });
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'capture_status',
      description:
        'Recording progress: shots done and left, by status, per group, and the state of the tips.',
      inputSchema: object({}),
    },
    async run(args) {
      return captureStatusOp(engine, await project(args));
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'capture_settings',
      description:
        'Recording settings (resolution, fps, bitrate, codec, container, HUD, HDR) with which are derived and which overridden, and the capture warnings. Change them with game-trailer_recording_set-overrides.',
      inputSchema: object({}),
    },
    async run(args) {
      return captureSettingsOp(engine, await project(args));
    },
  });

  add({
    mutates: true,
    tool: {
      name: 'capture_tips',
      description:
        'Ask the configured LLM for tips and risk notes per capture group and store them. Sends the shots and setup hints of the groups, never entities the user excluded. Groups with fresh tips are skipped unless force is true; hand-edited tips are kept unless overwriteEdited is true.',
      inputSchema: object({
        groupKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these groups (keys from capture_plan).',
        },
        force: { type: 'boolean' },
        overwriteEdited: { type: 'boolean' },
      }),
    },
    async run(args) {
      return captureTipsOp(engine, await project(args), {
        groupKeys: Array.isArray(args.groupKeys)
          ? args.groupKeys.filter((k): k is string => typeof k === 'string')
          : undefined,
        force: args.force === true,
        overwriteEdited: args.overwriteEdited === true,
      });
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'capture_export',
      description:
        "Write the capture pack (Markdown, printable HTML, JSON) under the project's exports/capture folder. Returns project-relative file paths. omitExcluded leaves out everything about entities the user excluded.",
      inputSchema: object({
        formats: { type: 'array', items: { type: 'string', enum: ['md', 'html', 'json'] } },
        omitExcluded: { type: 'boolean' },
      }),
    },
    async run(args) {
      return captureExportOp(engine, await project(args), {
        formats: Array.isArray(args.formats)
          ? args.formats.filter(
              (f): f is 'md' | 'html' | 'json' => f === 'md' || f === 'html' || f === 'json',
            )
          : undefined,
        omitExcluded: args.omitExcluded === true,
      });
    },
  });

  // ---------------------------------------------------------------- review, quality, render
  /**
   * Renders run in the background (a trailer takes minutes): `draft_start`, `export_start` and
   * `handoff_start` return at once, `render_status` shows progress and the last result, and
   * `render_cancel` stops one. One at a time per project.
   */
  interface Run {
    kind: 'draft' | 'export' | 'handoff';
    version: string;
    status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    progress?: Progress;
    result?: unknown;
    error?: { message: string; details?: unknown };
    controller: AbortController;
  }
  const runs = new Map<string, Run>();
  const versionArg = (args: Args): string | null =>
    typeof args.version === 'string' && args.version !== 'master' ? args.version : null;
  const VERSION_PROP = {
    type: 'string',
    description:
      'A version id from render_status or variants_status; omit (or "master") for the master cut.',
  };
  const startRun = async (
    kind: Run['kind'],
    args: Args,
    work: (
      store: ProjectStore,
      v: string | null,
      signal: AbortSignal,
      onProgress: (p: Progress) => void,
    ) => Promise<unknown>,
  ) => {
    const store = await project(args);
    const key = store.paths.dir;
    if (runs.get(key)?.status === 'running')
      throw new OpError(
        'usage',
        `a ${runs.get(key)!.kind} is already running for this project; see render_status`,
      );
    const v = versionArg(args);
    const run: Run = {
      kind,
      version: v ?? 'master',
      status: 'running',
      controller: new AbortController(),
    };
    runs.set(key, run);
    void work(store, v, run.controller.signal, (p) => (run.progress = p)).then(
      (result) => {
        run.status = run.controller.signal.aborted ? 'cancelled' : 'succeeded';
        run.result = result;
      },
      (err: unknown) => {
        run.status = run.controller.signal.aborted ? 'cancelled' : 'failed';
        run.error = {
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof OpError && err.details !== undefined ? { details: err.details } : {}),
        };
      },
    );
    return {
      started: kind,
      version: run.version,
      note: 'Poll render_status for progress and the result.',
    };
  };

  add({
    mutates: false,
    tool: {
      name: 'render_status',
      description:
        "Every version of the trailer (the master cut and each version) with: its approval (none, approved, or stale after the picture or sound changed), comments (open/total), whether a current review draft exists, the export preset and file name, and the Quality Gate summary (blocking, needing an override, warnings). Also the state of the render running or last run in this project. Edit comments with core_review_*; approving is the user's decision (the app or `tforge review approve`).",
      inputSchema: object({}),
      annotations: ReadOnly,
    },
    async run(args) {
      const store = await project(args);
      const r = runs.get(store.paths.dir);
      return {
        versions: await reviewViewOp(engine, store),
        comments: store.state.review.comments,
        render: r
          ? {
              kind: r.kind,
              version: r.version,
              status: r.status,
              progress: r.progress ?? null,
              result: r.result ?? null,
              error: r.error ?? null,
            }
          : null,
      };
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'qc_report',
      description:
        "The Quality Gate on one version's plan: placeholders and missing media, flash risk, jump cuts, screen direction, pacing, off-beat cuts, text outside the safe area or too short to read, brand contrast, and whether the export preset fits. Each finding says where (seconds), what, and what to do. 'blocking' findings always stop an export; 'needsOverride' ones stop it until the user overrides them with a reason (the app or `tforge export --override`); warnings never do. The file itself is checked again after rendering.",
      inputSchema: object({ version: VERSION_PROP }),
      annotations: ReadOnly,
    },
    async run(args) {
      return qualityOp(engine, await project(args), versionArg(args));
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'draft_start',
      description:
        'Start rendering a 720p review draft of a version in the background (cached by content: a version that did not change is not rendered again). Poll render_status.',
      inputSchema: object({ version: VERSION_PROP }),
    },
    async run(args) {
      return startRun('draft', args, (store, v, signal, onProgress) =>
        renderDraftOp(engine, store, v, { signal, onProgress }),
      );
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'export_start',
      description:
        "Start exporting a version in the background with its preset (set it with core_export_set): renders, checks the file (flash risk, loudness, true peak, clipping, size), and delivers it to the project's exports/render folder with a poster frame. Stops with the findings if the Quality Gate blocks it. Overriding a finding is the user's decision, so this tool takes no overrides. Poll render_status.",
      inputSchema: object({ version: VERSION_PROP }),
    },
    async run(args) {
      return startRun('export', args, (store, v, signal, onProgress) =>
        exportVersionOp(engine, store, v, { signal, onProgress }),
      );
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'handoff_start',
      description:
        'Start writing a version for an editor in the background: FCPXML, OpenTimelineIO and an EDL, with ProRes 4444 clips (alpha) for its cards and captions. Recordings are referenced where they are, never copied. Poll render_status.',
      inputSchema: object({
        version: VERSION_PROP,
        formats: {
          type: 'array',
          items: { type: 'string', enum: ['fcpxml', 'otio', 'edl'] },
          description: 'Default: all three.',
        },
      }),
    },
    async run(args) {
      const formats = Array.isArray(args.formats)
        ? args.formats.filter(
            (f): f is 'fcpxml' | 'otio' | 'edl' => f === 'fcpxml' || f === 'otio' || f === 'edl',
          )
        : undefined;
      return startRun('handoff', args, (store, v, signal, onProgress) =>
        handoffOp(engine, store, v, {
          signal,
          onProgress,
          ...(formats?.length ? { formats } : {}),
        }),
      );
    },
  });

  add({
    mutates: false,
    tool: {
      name: 'render_cancel',
      description:
        'Stop the render running in this project. Nothing partial is kept in the exports.',
      inputSchema: object({}),
    },
    async run(args) {
      const r = runs.get((await project(args)).paths.dir);
      if (r?.status !== 'running') return { cancelled: false };
      r.controller.abort(new Error('cancelled'));
      return { cancelled: true };
    },
  });

  // ---------------------------------------------------------------- one tool per command
  for (const type of engine.commands.types()) {
    if (HIDDEN_COMMANDS.has(type)) continue;
    const def = engine.commands.get(type)!;
    const json = z.toJSONSchema(def.payload as z.ZodType, { io: 'input' }) as Record<
      string,
      unknown
    >;
    delete json.$schema;
    if (json.type !== 'object') {
      console.error(`[trailerforge-mcp] skipping ${type}: payload is not an object`);
      continue;
    }
    const properties = { project: PROJECT_PROP, ...(json.properties as Record<string, unknown>) };
    const name = type.replace(/[/.]/g, '_');
    add({
      mutates: true,
      tool: {
        name,
        description: `${COMMAND_DESCRIPTIONS[type] ?? `Run command ${type}.`} Undoable. [${type}]`,
        inputSchema: { ...json, type: 'object', properties } as Tool['inputSchema'],
      },
      async run(args) {
        const store = await project(args);
        const { project: _ignored, ...payload } = args;
        const next = store.dispatch(type, payload);
        return { ok: true, revision: next.storyboard?.revision ?? null, canUndo: store.canUndo };
      },
    });
  }

  // ---------------------------------------------------------------- server
  const server = new Server(
    { name: 'trailerforge', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'TrailerForge plans game trailers. Start with project_summary, brief_get and storyboard_get. ' +
        'Edit with the command tools (all validated and undoable; use undo to revert). ' +
        'Locked sections refuse edits. storyboard_generate and storyboard_regenerate_section send the brief and non-excluded game facts to an LLM provider. ' +
        'Never invent ids for existing things; read them from storyboard_get / knowledge_list.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map((t) => t.tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const def = tools.get(req.params.name);
    if (!def) return failure(`unknown tool "${req.params.name}"`);
    try {
      const args = (req.params.arguments ?? {}) as Args;
      const out = await def.run(args);
      if (def.mutates) await (await project(args)).save();
      return result(out);
    } catch (err) {
      return describeError(err);
    }
  });
  return server;
}
