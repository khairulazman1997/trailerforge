Suggest {{count}} alternative openings (hooks) for a short vertical {{format}} video, for A/B testing. The body of the video stays the same; only the first seconds and the words over them change.

The concept:
{{concept}}

The opening shot today (JSON): what it shows, how long it is on screen, and the words over it now:
{{opening}}

Voiceover the developer will speak, in order (a hook must not contradict it):
{{voiceover}}

Brief (JSON):
{{brief}}

Game facts (id: kind: name — description):
{{knowledge}}

Rules:

- Each hook is a different approach: for example a cold open (no words, straight into the action), a text hook (a bold statement or number), a question the viewer wants answered, a promise ("Watch the boss die in 3 seconds"). Do not give two hooks the same idea.
- "caption" is the on-screen text over the opening shot: at most 10 words, readable with the sound off, empty for a cold open. Never a logo or "Hi, we are…".
- "kind" is one of "cold-open", "text", "question", "custom".
- "name" is a short label for the person comparing results (at most 40 characters). "why" is one sentence on why it might hold attention.
- Use real places, characters, enemies and mechanics from the game facts; never invent features.
- The first second decides everything: lead with the most surprising true thing.

Return JSON: {"hooks": [{"name": "...", "kind": "text", "caption": "...", "why": "..."}]}
