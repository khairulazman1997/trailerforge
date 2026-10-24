/**
 * Plain-language descriptions for command tools (the Zod payload gives the argument shapes but
 * not the intent). Commands not listed here still get a generic description.
 */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
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
  'core/knowledge.apply-scan',
  'core/storyboard.set',
  'core/storyboard.replace-section',
]);
