import { groupLabel, type CapturePack, type CapturePackItem } from './capture-pack.js';

type Hint = CapturePack['setup']['debugCommands'][number];

const one = (s: string): string => s.replace(/\s+/g, ' ').trim();

const escapeMd = (s: string): string => s.replace(/([\\`*_[\]<>|~#])/g, '\\$1');

/**
 * Inline Markdown text: neutralise formatting, links, HTML and table breaks. Paired backticks
 * (the extractor writes commands as code) stay as code spans, whose content is literal.
 */
function md(s: string): string {
  return one(s)
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part.replace(/\|/g, '\\|') : escapeMd(part)))
    .join('');
}

export function html(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** HTML text where paired backticks (the extractor writes commands as code) become `<code>`. */
const htmlRich = (s: string): string =>
  s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? `<code>${html(part.slice(1, -1))}</code>` : html(part)))
    .join('');

const fmtSeconds = (n: number): string => `${Math.round(n * 10) / 10}`;
const minutes = (s: number): string => (s < 90 ? `${s} s` : `${Math.round(s / 6) / 10} min`);
const res = (r: { width: number; height: number }): string => `${r.width}×${r.height}`;

interface Row {
  label: string;
  value: string;
  source: string;
}

function settingRows(pack: CapturePack): Row[] {
  const { settings: s, sources } = pack.recording;
  const src = (k: string) => (sources[k] === 'override' ? 'your override' : 'derived');
  return [
    { label: 'Resolution', value: res(s.resolution), source: src('resolution') },
    { label: 'Frame rate', value: `${s.fps} fps, constant`, source: src('fps') },
    { label: 'Bitrate', value: `${s.bitrateMbps} Mbps`, source: src('bitrateMbps') },
    { label: 'Codec', value: s.codec.toUpperCase(), source: src('codec') },
    { label: 'Container', value: s.container.toUpperCase(), source: src('container') },
    {
      label: 'HUD',
      value: s.hud === 'per-shot' ? 'per shot (see each item)' : s.hud,
      source: src('hud'),
    },
    { label: 'HDR', value: s.hdr ? 'on' : 'off (record SDR)', source: src('hdr') },
  ];
}

function itemFacts(it: CapturePackItem): { label: string; value: string }[] {
  const facts = [
    { label: 'Do', value: it.instruction },
    { label: 'Framing', value: it.framing },
    { label: 'Setup', value: it.setup },
    { label: 'Why', value: it.purpose },
    { label: 'Alternates', value: it.alternates.map(one).join('; ') },
    { label: 'Features', value: it.entities.map((e) => e.name).join(', ') },
    { label: 'Notes', value: it.notes },
    { label: 'Takes', value: it.takes > 0 ? String(it.takes) : '' },
  ];
  return facts.filter((f) => one(f.value) !== '');
}

function itemHead(it: CapturePackItem): string {
  const cut = `${fmtSeconds(it.cutSeconds.ideal)} s cut (${fmtSeconds(it.cutSeconds.min)}–${fmtSeconds(it.cutSeconds.max)} s)`;
  const parts = [
    `record ${it.recordSeconds} s`,
    cut,
    `HUD ${it.hud}`,
    ...(it.priority === 'nice' ? ['nice to have'] : []),
    ...(it.status === 'rejected' ? ['rejected, record again'] : []),
  ];
  return parts.join(' · ');
}

const mdHints = (label: string, hs: Hint[]): string[] =>
  hs.length === 0
    ? []
    : [
        `${label}:`,
        ...hs.map((h) => `- **${md(h.name)}**${h.detail ? ` — ${md(h.detail)}` : ''}`),
        '',
      ];

export function renderCapturePackMarkdown(pack: CapturePack): string {
  const out: string[] = [];
  const { progress: p } = pack;
  out.push(
    `# ${md(pack.project.name)} — capture pack`,
    '',
    `${p.done} of ${p.total} shots recorded · about ${minutes(p.todoRecordSeconds)} of footage still to record · storyboard revision ${pack.storyboard.revision}`,
    '',
    '## Recording settings',
    '',
    '| Setting | Value | |',
    '| --- | --- | --- |',
    ...settingRows(pack).map((r) => `| ${r.label} | ${md(r.value)} | ${r.source} |`),
    '',
  );
  if (pack.recording.advice.length > 0) {
    out.push(
      ...pack.recording.advice.map(
        (a) => `- **${a.severity === 'warn' ? 'Watch out' : 'Note'}:** ${md(a.message)}`,
      ),
      '',
    );
  }
  if (pack.setup.debugCommands.length + pack.setup.saveFiles.length > 0) {
    out.push('## Setup that applies everywhere', '');
    out.push(...mdHints('Debug commands', pack.setup.debugCommands));
    out.push(...mdHints('Save files', pack.setup.saveFiles));
  }
  out.push('## Checklist', '');
  if (pack.groups.length === 0) out.push('Nothing to record.', '');
  pack.groups.forEach((g, i) => {
    out.push(`### ${i + 1}. ${md(g.label)} (${g.done}/${g.total})`, '');
    out.push(...mdHints('Level', g.hints.levels));
    out.push(...mdHints('Debug commands', g.hints.debugCommands));
    out.push(...mdHints('Save files', g.hints.saveFiles));
    if (g.tips) {
      out.push(
        ...(g.tips.tips.length ? ['Tips:', ...g.tips.tips.map((t) => `- ${md(t)}`), ''] : []),
        ...(g.tips.risks.length ? ['Risks:', ...g.tips.risks.map((t) => `- ${md(t)}`), ''] : []),
      );
    }
    for (const it of g.items) {
      out.push(
        `- [${it.done ? 'x' : ' '}] **${md(it.title || it.slotId)}** (\`${it.slotId}\`, ${md(it.section)}) — ${md(itemHead(it))}`,
      );
      for (const f of itemFacts(it)) out.push(`  - ${f.label}: ${md(f.value)}`);
    }
    out.push('');
  });
  if (pack.skipped.length > 0) {
    out.push(
      '## Skipped shots',
      '',
      ...pack.skipped.map((s) => `- ${md(s.title)} (\`${s.slotId}\`)`),
      '',
    );
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font: 14px/1.5 system-ui, "Segoe UI", sans-serif; color: #1a1a1a; background: #fff; margin: 0 auto; max-width: 52rem; padding: 1.5rem 1rem 3rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; border-bottom: 1px solid #ccc; padding-bottom: .2rem; }
h3 { font-size: 1.05rem; margin: 0 0 .4rem; }
.meta { color: #555; margin: 0 0 1rem; }
table { border-collapse: collapse; }
th, td { text-align: left; padding: .2rem .8rem .2rem 0; vertical-align: top; }
td.src { color: #666; font-size: .85em; }
.note { margin: .2rem 0; }
.warn { color: #8a3b00; font-weight: 600; }
.group { margin: 1.25rem 0; padding: .75rem 1rem; border: 1px solid #bbb; border-radius: 6px; break-inside: avoid-page; }
.group h3 .count { color: #666; font-weight: 400; }
ul { margin: .25rem 0 .5rem; padding-left: 1.2rem; }
.items { list-style: none; padding: 0; }
.item { display: flex; gap: .6rem; padding: .5rem 0; border-top: 1px solid #e4e4e4; break-inside: avoid; }
.box { flex: none; width: 1.1rem; height: 1.1rem; margin-top: .15rem; border: 2px solid #333; border-radius: 3px; text-align: center; line-height: .8rem; font-size: .85rem; }
.item.done .box::after { content: "✓"; }
.item.done .title { text-decoration: line-through; color: #666; }
.title { font-weight: 600; }
.head { color: #444; }
dl { margin: .25rem 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 0 .75rem; }
dt { color: #666; }
dd { margin: 0; }
code { font: .9em ui-monospace, Consolas, monospace; background: #f1f1f1; padding: 0 .25em; border-radius: 3px; }
@media print { body { max-width: none; padding: 0; font-size: 11pt; } .group { page-break-inside: avoid; } h2 { page-break-after: avoid; } }
`;

const hHints = (label: string, hs: Hint[]): string =>
  hs.length === 0
    ? ''
    : `<p class="note"><strong>${label}</strong></p><ul>${hs
        .map(
          (h) =>
            `<li><strong>${html(h.name)}</strong>${h.detail ? ` — ${htmlRich(h.detail)}` : ''}</li>`,
        )
        .join('')}</ul>`;

/** One self-contained page: inline CSS, no scripts, no external references. */
export function renderCapturePackHtml(pack: CapturePack): string {
  const { progress: p } = pack;
  const parts: string[] = [];
  parts.push(
    `<h1>${html(pack.project.name)} — capture pack</h1>`,
    `<p class="meta">${p.done} of ${p.total} shots recorded · about ${minutes(p.todoRecordSeconds)} of footage still to record · storyboard revision ${pack.storyboard.revision}</p>`,
    '<h2>Recording settings</h2>',
    `<table>${settingRows(pack)
      .map(
        (r) =>
          `<tr><th scope="row">${r.label}</th><td>${html(r.value)}</td><td class="src">${r.source}</td></tr>`,
      )
      .join('')}</table>`,
    ...pack.recording.advice.map(
      (a) =>
        `<p class="note"><span class="${a.severity === 'warn' ? 'warn' : ''}">${a.severity === 'warn' ? 'Watch out' : 'Note'}:</span> ${html(a.message)}</p>`,
    ),
  );
  if (pack.setup.debugCommands.length + pack.setup.saveFiles.length > 0) {
    parts.push(
      '<h2>Setup that applies everywhere</h2>',
      hHints('Debug commands', pack.setup.debugCommands),
      hHints('Save files', pack.setup.saveFiles),
    );
  }
  parts.push('<h2>Checklist</h2>');
  if (pack.groups.length === 0) parts.push('<p>Nothing to record.</p>');
  pack.groups.forEach((g, i) => {
    const tips = g.tips
      ? `${g.tips.tips.length ? `<p class="note"><strong>Tips</strong></p><ul>${g.tips.tips.map((t) => `<li>${html(t)}</li>`).join('')}</ul>` : ''}${g.tips.risks.length ? `<p class="note"><strong>Risks</strong></p><ul>${g.tips.risks.map((t) => `<li>${html(t)}</li>`).join('')}</ul>` : ''}`
      : '';
    const items = g.items
      .map((it) => {
        const facts = itemFacts(it)
          .map((f) => `<dt>${f.label}</dt><dd>${html(f.value)}</dd>`)
          .join('');
        return `<li class="item${it.done ? ' done' : ''}"><span class="box" aria-hidden="true"></span><div><div><span class="title">${html(it.title || it.slotId)}</span> <code>${html(it.slotId)}</code> <span class="head">${html(it.section)} — ${html(itemHead(it))}</span></div>${facts ? `<dl>${facts}</dl>` : ''}</div></li>`;
      })
      .join('');
    parts.push(
      `<section class="group"><h3>${i + 1}. ${html(g.label)} <span class="count">(${g.done}/${g.total})</span></h3>${hHints('Level', g.hints.levels)}${hHints('Debug commands', g.hints.debugCommands)}${hHints('Save files', g.hints.saveFiles)}${tips}<ul class="items">${items}</ul></section>`,
    );
  });
  if (pack.skipped.length > 0) {
    parts.push(
      '<h2>Skipped shots</h2>',
      `<ul>${pack.skipped.map((s) => `<li>${html(s.title)} <code>${html(s.slotId)}</code></li>`).join('')}</ul>`,
    );
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(pack.project.name)} — capture pack</title>
<style>${CSS}</style>
</head>
<body>
${parts.filter(Boolean).join('\n')}
</body>
</html>
`;
}

export { groupLabel };
