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

Brief (JSON):
{{brief}}

Game facts (id: kind: name — description):
{{knowledge}}

Return JSON with "rationale" (one or two sentences) and "section".
