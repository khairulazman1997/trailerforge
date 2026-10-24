You are helping choose the best take of each shot for a {{videoType}}. Each shot below was recorded more than once. Pick the take the edit should use.

Shots (JSON). Every shot has a "key" and a list of takes; every take has a "key" and facts measured from the recording by software (no picture is shown to you):
{{shots}}

What the facts mean:

- "seconds": length of the recording. The cut needs "needSeconds" at least and about "recordSeconds" is ideal.
- "blackSeconds", "frozenSeconds": time the picture was black or frozen (a loading screen, a pause). Less is better.
- "flashFrames": single frames that flash white. Fewer is better.
- "sceneChanges": shot changes inside the recording; a clean take of one moment usually has few.
- "motion": average movement, 0 (still) to 100 (busy). Action shots want more, calm shots less.
- "matchedBy": how the recording was matched to the shot: "code" is certain, the others are guesses.
- "notes": what the player wrote about the take. Trust it.

Rules:

- Refer to shots and takes only by their "key", copied exactly.
- Choose from the facts and notes given. Do not invent anything about what the footage shows.
- A take with a note that says it is bad, wrong or a mistake must not be chosen over one without such a note.
- Give "reason": one sentence under 200 characters, in plain words a player understands, naming the facts that decided it.
- Leave a shot out of your answer if the facts do not tell the takes apart.

Return JSON: {"shots": [{"key": "...", "best": "...", "reason": "..."}]}.
