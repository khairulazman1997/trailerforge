Write a storyboard for a {{videoType}} lasting {{targetDuration}} seconds. The sections you write must fill {{budget}} seconds in total; sections listed under "Locked" are already final and are added back automatically, so do not write them again.

Start from this template structure. Keep its order and roles unless the brief clearly calls for something else, and replace the generic beats with concrete moments from this game:
{{skeleton}}

Locked sections (keep the story consistent with them):
{{locked}}

Rules:

- Every shot needs a captureInstruction the player can follow exactly: what to do, where, and what state the game must be in.
- Prefer real places, characters, enemies and mechanics from the game facts. Put their ids in entityIds; never invent ids.
- Cards (kind "card") carry on-screen text in "text" and a cardKind: title, tagline, date, laurels, quote, logo, cta or custom.
- Give a voLine only where narration or a spoken line helps; many trailers need none.
- "seconds" is the on-screen time of each slot. Most gameplay shots are 1–4 seconds.
- Values in the brief marked as assumptions are guesses; use them, but don't build the trailer around them.

Brief (JSON):
{{brief}}

Assumptions made for missing fields:
{{assumptions}}

Game facts (id: kind: name — description):
{{knowledge}}

Return JSON with "rationale" (two or three sentences on the structure you chose and why), "sections" and "music".
