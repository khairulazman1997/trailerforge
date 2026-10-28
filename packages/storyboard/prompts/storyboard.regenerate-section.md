Rewrite one section of a {{videoType}} storyboard. The new section replaces "{{sectionName}}" (role: {{role}}) and must fill {{budget}} seconds, not counting any fixed slots listed below. Every other section stays as it is, so the new one has to fit between its neighbours.

Current storyboard (the section to rewrite is marked >>>):
{{outline}}

Slots the user edited by hand stay exactly as they are, in the positions shown, and are added back automatically. Do not write them again, and don't repeat them; write the other slots so the section still flows. Fixed slots:
{{pinned}}

What the user wants changed:
{{instruction}}

Rules:

- Every shot needs a captureInstruction the player can follow exactly.
- Prefer real places, characters, enemies and mechanics from the game facts. Put their ids in entityIds; never invent ids.
- Do not repeat shots that already appear in other sections.
- "seconds" is the on-screen time of each slot.
- On-screen text over a shot ("onScreenText") only where the viewer needs words: a short feature callout, or style "name" the first time a boss or character appears. Leave it out of every other shot.
- Transitions, effects and sounds ("transitionIn", "effect", "sound") are rare accents, not decoration. Most slots get none: a hard cut on the beat is the default and almost always right. Add one only where it serves the edit, and say why in its "why": a whip or flash into a big reveal, a dip to black before the title or end slate, an impact sound on the boss reveal or the music's drop, a riser leading into the climax. At most one slot in three may carry any of them; a typical trailer uses three to six in total. Use only these ids:
{{picks}}

Brief (JSON):
{{brief}}

Game facts (id: kind: name — description):
{{knowledge}}

Return JSON with "rationale" (one or two sentences) and "section".
