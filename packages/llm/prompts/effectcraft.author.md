You write a custom motion-graphics effect for a game trailer as a list of EffectCraft commands. EffectCraft is a motion-graphics program with layers, properties, keyframes and effects in the style of After Effects. You see TEXT ONLY.

The request (JSON):
{{request}}

- "words": what the maker wants, in their words.
- "seconds": how long the effect runs. "landAt" (if present): the second, from the effect's start, where its main hit must land (a flash, the title snapping in, a burst): put the strongest change exactly there.
- "size" and "frameRate": the picture's size in pixels and its frame rate.
- "brand": the maker's colours (hex) and font families. Use them unless the words ask otherwise.

What already exists: one composition named "{{comp}}", of exactly that size, frame rate and length, transparent, active. Do not create or change compositions. The effect is drawn OVER the video with its transparency, so leave the background empty unless the words ask for a full-screen card.

Commands you may use (nothing else is run): {{commands}}.

Rules:

- Give every layer a "name" when you create it and refer to it by that name ("layer": "Title"). Never use layer numbers.
- Times are seconds from the effect's start; keep keyframes inside 0..seconds.
- Property paths: "transform/position" [x, y] in pixels from the top left, "transform/scale" [x, y] in percent, "transform/opacity" 0..100, "transform/rotation" in degrees, "transform/anchor" [x, y]; text layers also "text/sourceText".
- layer.newText: {name, text, position [x, y], font (a family name), style ("Regular", "Bold"), size (px), fill (hex), justify (left, center, right), tracking, leading}. Keep text short; it must stay inside the middle 80% of the picture.
- layer.newSolid: {name, color (hex), width, height}. layer.newShape: {name, kind (rectangle, ellipse, star, polygon)}. layer.newNull: {name}.
- prop.set: {layer, path, value}. prop.addKey: {layer, path, time, value}.
- Easing: keys.select {keys: [{layer, path, time}]} selects keyframes; then keys.easyEase {which: both|in|out} or keys.toggleHold {}.
- effect.apply: {layer, effect} with an effect name such as "Glow", "Gaussian Blur", "Fill", "Drop Shadow"; then prop.set {layer, path: "effects/#1/<parameter>", value}.
- No file paths, URLs, footage, images, expressions or scripts. No flashing more than three times in any one second (photosensitivity).
- At most {{maxCommands}} commands.

Reply with JSON only: {"name": short name, "summary": one sentence saying what it looks like, "commands": [{"command": id, "params": {...}}, ...]}.
