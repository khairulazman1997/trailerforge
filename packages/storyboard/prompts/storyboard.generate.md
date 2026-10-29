Write a storyboard for a {{videoType}} lasting {{targetDuration}} seconds. The sections you write must fill {{budget}} seconds in total; sections listed under "Locked" are already final and are added back automatically, so do not write them again.

{{structure}}
{{skeleton}}

Locked sections (keep the story consistent with them):
{{locked}}

Rules:

- Every shot needs a captureInstruction the player can follow exactly: what to do, where, and what state the game must be in.
- Prefer real places, characters, enemies and mechanics from the game facts. Put their ids in entityIds; never invent ids.
- Cards (kind "card") carry on-screen text in "text" and a cardKind: title, tagline, date, laurels, quote, logo, cta or custom.
- Give a voLine only where narration or a spoken line helps; many trailers need none.
- On-screen text over a shot ("onScreenText") is the exception, not the rule. Add it only when the viewer needs words to understand the shot or to catch a key selling point: a short feature callout ("Parry anything"), or, with style "name", a name label the first time a boss or character appears. Leave "onScreenText" out of every other shot; a typical trailer has text over only a handful of shots, often none. Never repeat what the picture already shows, and never use it for titles, dates or calls to action: those belong on cards.
- Transitions, effects and sounds ("transitionIn", "effect", "sound") are rare accents, not decoration. Most slots get none: a hard cut on the beat is the default and almost always right. Add one only where it serves the edit, and say why in its "why": a whip or flash into a big reveal, a dip to black before the title or end slate, an impact sound on the boss reveal or the music's drop, a riser leading into the climax. At most one slot in three may carry any of them; a typical trailer uses three to six in total. Use only these ids:
{{picks}}
- "seconds" is the on-screen time of each slot. Most gameplay shots are 1–4 seconds.
- Values in the brief marked as assumptions are guesses; use them, but don't build the trailer around them.

Brief (JSON):
{{brief}}

Assumptions made for missing fields:
{{assumptions}}

Game facts (id: kind: name — description):
{{knowledge}}

Return JSON with "rationale" (two or three sentences on the structure you chose and why), "sections" and "music".
