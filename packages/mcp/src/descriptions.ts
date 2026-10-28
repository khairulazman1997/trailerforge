/**
 * Plain-language descriptions for command tools (the Zod payload gives the argument shapes but
 * not the intent). Commands not listed here still get a generic description.
 */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  'core/variants.add':
    'Add a version of the trailer for a format target (aspect ratio, frame rate), optionally cut down to targetDuration seconds. It is derived from the master cut on demand; nothing is copied.',
  'core/variants.remove': 'Remove a version.',
  'core/variants.set':
    "Change a version's name, format target, length (null = the master's) or reframing (crop follows the subject, fill shows every shot whole).",
  'core/variants.override':
    'In one version: drop (excluded true) or keep (false) a shot, retime it (duration), use another take (takeId) or set where the crop looks (cropCenter). null clears one setting. Overrides survive a rebuild of the master cut.',
  'core/variants.clear-override':
    "Forget one shot's overrides in a version, or all of them when no slot is given.",
  'core/brand.set-colors':
    'Set brand colours (background, text, primary, accent as #rrggbb) for trailer graphics.',
  'core/brand.set-scale':
    "Set text sizes as a share of the frame's shorter side (title, heading, body, caption).",
  'core/brand.reset': 'Forget the whole brand kit.',
  'core/export.set':
    'Choose how a version is exported: the preset (core/youtube, core/steam, core/vertical, core/x, core/master), the file name pattern ({project}, {version}, {format}, {preset}), a loudness target override in LUFS, and where the poster frame is taken (seconds). null clears an override.',
  'core/export.reset': "Back to the default export for the version's shape.",
  'core/review.comment':
    'Leave a comment on a version (variantId null = the master cut) at a time (flicks), optionally on the timeline item under it. Comments never change the render, so they never make an approval stale.',
  'core/review.edit': 'Change the text of a comment.',
  'core/review.resolve': 'Mark a comment as dealt with.',
  'core/review.reopen': 'Reopen a resolved comment.',
  'core/review.delete': 'Delete a comment.',
  'core/review.revoke': "Withdraw a version's approval.",
  'core/timeline.set-clip-audio':
    "Turn a clip's own sound on or off (off by default; music and effects carry a trailer), with a gain and optional J-cut lead and L-cut lag (flicks, at most one second).",
  'core/timeline.set-effects':
    'Set the finishing effects on a picture item by hand (effect ids from effects_list). A rebuild of the cut keeps them.',
  'core/storyboard.add-sfx-cue':
    'Put a sound effect (whoosh, riser, impact, sub-drop) on a shot or card: before it, at its start or at its end.',
  'core/storyboard.remove-sfx-cue': 'Take a sound effect off its slot.',
  'game-trailer/capture.apply-tips':
    'Store generated capture tips for groups. Groups the user edited are kept unless overwriteEdited is true.',
  'game-trailer/capture.edit-tips':
    'Replace the tips and risk notes of one capture group by hand. Marks them edited so regenerating leaves them alone.',
  'game-trailer/capture.clear-tips':
    'Remove the capture tips of one group (key), or of all groups.',
  'game-trailer/capture.set-status':
    'Mark a shot slot empty, recorded, approved or rejected. Works in locked sections; the storyboard itself is unchanged.',
  'game-trailer/capture.set-notes': 'Set the capture notes on a shot slot.',
  'game-trailer/capture.set-takes': 'Set how many takes have been recorded for a shot slot.',
  'game-trailer/capture.set-skipped':
    'Skip a shot (leave it out of the capture checklist) or restore it.',
  'game-trailer/capture.reorder-group':
    "Reorder the shots of one capture group: pass exactly that group's slot ids in the new order. The storyboard order is unchanged.",
  'game-trailer/recording.set-overrides':
    'Override recording settings (resolution, fps, bitrateMbps, codec, container, hud, hdr). Send null to clear one override and go back to the derived value.',
  'game-trailer/recording.reset-overrides':
    'Clear every recording-setting override and go back to the derived settings.',
  'core/brief.set-field':
    'Set one brief field by path, e.g. path "brief.title" or "brief.extensions.game-trailer.genre". Replaces any assumption for that field.',
  'core/brief.set-video-type':
    'Change the project video type (e.g. "game-trailer/release-trailer").',
  'core/brief.add-assumption':
    'Record a visible assumption for a brief field the user has not answered, so generation can proceed.',
  'core/brief.remove-assumption': 'Remove the assumption recorded for a brief field.',
  'core/project.rename': 'Rename the project.',
  'core/project.set-status': 'Set the project status.',
  'core/project.set-extension': 'Set plugin data on the project under a plugin id.',
  'core/project.add-format-target':
    'Add an output format target (aspect ratio, resolution, length, platform).',
  'core/project.remove-format-target': 'Remove an output format target by id.',
  'core/knowledge.add-source':
    'Register a game repo or folder as a knowledge source (does not scan it).',
  'core/knowledge.remove-source':
    "Remove a knowledge source. Entities the storyboard uses are kept as the user's own; the rest go.",
  'core/knowledge.add-entity':
    'Add a game fact by hand (level, boss, ability, item...). It survives re-scans.',
  'core/knowledge.update-entity':
    "Edit a knowledge entry. Editing an extracted entry makes it the user's, so scans stop overwriting it.",
  'core/knowledge.set-excluded':
    'Exclude a knowledge entry from (or allow it for) anything sent to an LLM.',
  'core/knowledge.remove-entity':
    'Delete a knowledge entry. Refused if the storyboard uses it; exclude it instead.',
  'core/storyboard.set-section-locked':
    'Lock or unlock a section. Locked sections refuse edits and are never changed by generation.',
  'core/storyboard.set-target-duration': 'Change the storyboard target length in seconds.',
  'core/storyboard.update-slot':
    'Edit fields of one slot (title, purpose, duration {min,ideal,max} in seconds, capture instruction, setup, HUD, card text, entity ids...). The slot is then remembered as hand-edited, so regenerating its section keeps it.',
  'core/storyboard.add-slot':
    'Add a slot (a "shot" to record, or a "card" for on-screen text) to an unlocked section. You choose its id.',
  'core/storyboard.remove-slot':
    'Delete a slot and everything that pointed at it (VO lines, music cues, variant overrides, timeline links).',
  'core/storyboard.move-slot': 'Move a slot within its section or into another unlocked section.',
  'core/storyboard.add-section': 'Add an empty section. You choose its id.',
  'core/storyboard.update-section': 'Rename a section or change its role hint or purpose.',
  'core/storyboard.move-section': 'Move an unlocked section to a new position.',
  'core/storyboard.remove-section': 'Delete an unlocked section and its slots.',
  'core/storyboard.add-vo-line':
    'Add a voice-over line, optionally linked to slots. You choose its id.',
  'core/storyboard.update-vo-line':
    'Edit a voice-over line (text, direction, target seconds, linked slots).',
  'core/storyboard.remove-vo-line': 'Delete a voice-over line.',
  'core/storyboard.update-music':
    'Edit the music plan: direction, tempo range (bpm) or track asset.',
};

/**
 * Commands that exist for the app's own use and are not offered as tools: they carry bulk
 * results that the action tools produce (scan results, a whole generated storyboard).
 */
export const HIDDEN_COMMANDS = new Set([
  // Which logo or font files go into a project is the user's choice (screens, `tforge brand`).
  'core/brand.set-logo',
  'core/brand.set-font',
  // Approving is the user's sign-off, and the plan hash must come from the real content: the
  // app and `tforge review approve` compute it. Claude can read approvals in render_status.
  'core/review.approve',
  'core/knowledge.apply-scan',
  'core/storyboard.set',
  'core/storyboard.replace-section',
]);
