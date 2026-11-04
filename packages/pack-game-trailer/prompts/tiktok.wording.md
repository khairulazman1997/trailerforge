Write the wording for the slots of a short vertical {{format}} video. The structure is fixed: you do not add, remove or reorder anything, you only improve the words of the slots listed below.

The concept:
{{concept}}

Voiceover the developer will speak, in order (the picture should support it; do not repeat it as text):
{{voiceover}}

Slots to write (JSON). Each has a "key", its "kind" ("shot" or "card"), its job ("purpose"), how long it is on screen ("seconds"), what may fill it ("accepts": gameplay recording, image or video) and the words it has now:
{{slots}}

Brief (JSON):
{{brief}}

Game facts (id: kind: name — description):
{{knowledge}}

Rules:

- Refer to slots only by their "key", copied exactly. Leave a slot out if its words are already good.
- For a shot: "title" is a short label (at most 50 characters); "captureInstruction" says exactly what to film, record or show, in plain words a small team can do this week (at most 220 characters). If it accepts an image, say which image (key art, a screenshot, a sketch).
- For a card: "text" is what the card says (at most 60 characters), in the game's tone.
- "captionText" only where a slot has "caption": the on-screen words for the first seconds, at most 8 words, readable with the sound off. Never a logo or "Hi, we are…".
- Use real places, characters, enemies and mechanics from the game facts; never invent features.
- Keep the length in mind: a slot of 1.5 seconds shows one thing.

Return JSON: {"slots": [{"key": "...", "title": "...", "captureInstruction": "...", "text": "...", "captionText": "..."}]}. Include only the fields you are changing.
