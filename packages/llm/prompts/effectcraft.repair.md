Your EffectCraft commands for this effect could not be used.

The request (JSON):
{{request}}

What you sent:
{{previous}}

What went wrong:
{{problems}}

Fix exactly these problems and send the whole corrected effect again, keeping the look you were going for. The same rules hold:

- only these commands: {{commands}};
- every layer named when created and referred to by name; no compositions created or changed; no files, URLs, footage, expressions or scripts;
- a matte layer sits directly above the layer it mattes; text animator values on "text/animators/#n/properties/<property>", selectors on "text/animators/#n/selectors/#m/start" | "end" | "offset";
- no refused presets (strobe, shake, flicker, blink, jitterScale, bouncingBall, rubberBand, wobble, heartbeat, bounceInWords, jitter, scramble) and no expression selectors;
- no flashing more than three times in any one second.

If EffectCraft refused a parameter or a property path and named the valid ones, use one of those. If a command is not available, build the same look from the ones that are (a blurred solid as a matte instead of a mask feather, a text animator instead of a text preset).

Reply with JSON only: {"name", "summary", "commands"}.
