Rewrite one section of a {{videoType}} storyboard. The new section replaces "{{sectionName}}" (role: {{role}}) and must fill {{budget}} seconds. Every other section stays as it is, so the new one has to fit between its neighbours.

Current storyboard (the section to rewrite is marked >>>):
{{outline}}

What the user wants changed:
{{instruction}}

Rules:

- Every shot needs a captureInstruction the player can follow exactly.
- Prefer real places, characters, enemies and mechanics from the game facts. Put their ids in entityIds; never invent ids.
- Do not repeat shots that already appear in other sections.
- "seconds" is the on-screen time of each slot.

Brief (JSON):
{{brief}}

Game facts (id: kind: name — description):
{{knowledge}}

Return JSON with "rationale" (one or two sentences) and "section".
