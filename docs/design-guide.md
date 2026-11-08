# CoreView design guide

How CoreView screens should look and feel, written down so any contributor
(human or agent) can design a widget that belongs. Look at the reference
widgets while reading: the Aquarium (`public/render-aquarium.js`), the
Terrarium (`public/render-lab.js`) and the household board
(`docs/screenshots/household-board.png`).

## Who it is for

Screens hang on walls and sit on counters in a family home. They are read in
**two seconds, from across the room, by people who are not looking for it**:
kids, grandparents, someone carrying groceries. Nobody configures anything on
the screen itself. Design for that person, not for the developer.

## The six rules

1. **Glanceable first.** One big idea per widget. The most important fact is
   the largest thing on it and readable from about 3 m. Detail is small and
   secondary, or not there at all.
2. **Calm by default.** A normal day looks peaceful: soft colour, slow motion
   (8 s+ loops), no blinking. The screen should be pleasant to live with.
3. **Loud only when it matters, and honestly.** Exactly one level of alarm:
   saturated red plus words that name the problem ("Laundry leak"). Reserve it
   for things a person must act on now. Warnings that can wait are amber. If
   the data source is silent, show that ("Can't hear Home Assistant", grey and
   still): a calm picture that might be lying is the worst outcome.
4. **Metaphor over chart.** The best widgets are small worlds where the data
   *is* the picture: people are fish, doors are clams, hosts are plants,
   lines are train routes. A good metaphor maps every data point to one
   visible thing and a state change to a visible change (open clam glows,
   wilting plant, train waiting at a station). If a mapping needs a legend,
   simplify it.
5. **Words a family member uses.** "Back door open 12 min", not
   `binary_sensor.back_door: on`. First names, not full names. No units the
   reader didn't ask for, no percentages where a word works ("nearly full").
6. **Same on every screen.** Inline SVG and CSS, no emoji or icon fonts, em
   sizing so the `size` field scales it, landscape 16:9 first and still sane
   in portrait and on a 1024x600 Echo Show.

## Look

- **Type:** Manrope (default UI and numbers), Nunito (friendly, kids'
  widgets), Fraunces (accent headings, elegant views), Patrick Hand /
  Permanent Marker (whiteboard only). `CVRender.FONTS` has the stacks. Weights
  600-800 for anything read at a distance; numbers get tight letter spacing.
- **Colour:** dark or photo backgrounds with white text (`#ffffff`, shadow on
  for text over photos), or the warm paper look (`#f7f4ee` on `#20252b`).
  Accents: blue `#1e88e5`, green `#43a047`, amber `#ffb257`/`#fb8c00`, alarm
  red `#e53935` (rule 3 only). Each person keeps their own colour everywhere
  (the people rows carry it).
- **Space:** generous. Less on screen beats a full screen. Keep 4-6% margins
  from the widget edge; don't place text over busy parts of a picture.
- **Motion:** CSS keyframes only, slow and organic (sway, drift, bubbles),
  phase derived from the clock so a redraw doesn't restart it. Nothing flashes
  except a real alarm, and even that pulses slowly.
- **Day and night:** worlds should follow `sun.sun` (darker palette, stars,
  dimmer light at night). Bedroom screens are looked at in the dark.

## Making a new world (the Aquarium / Terrarium pattern)

1. Write the mapping first, as the comment at the top of the renderer:
   `thing -> how it looks`, one line each, including "silent".
2. Pick 3-6 *kinds* of thing (lines, characters, groups), not 3-6 stops or
   readings: a line can carry many stops. Decide the overflow rule up front
   (at most N visible, then shrink, or summarise "+3 more"); the picture must
   still read in two seconds with the most stops the household has.
3. Sketch the calm state, then the single worst state. Both must read in two
   seconds.
4. Every state from step 1 becomes a smoke-test scene with a screenshot.

## Review checklist (run it on your screenshots)

- [ ] From 3 m (or the screenshot at 25%): can you tell if all is well?
- [ ] Is the most important fact the biggest thing?
- [ ] Does the calm state look calm? Does the alarm state look like an alarm,
      and is red used for nothing else?
- [ ] Data missing: does it say so in words?
- [ ] Any developer word, entity id, raw number or emoji on screen?
- [ ] Night variant checked (if it follows the sun)?
- [ ] Portrait and a small 1024x600 screen still readable?
- [ ] No real names, addresses or house data in fixtures or screenshots?

## Handing a design to the builder

When one agent designs and another builds (or a concept comes from an Idea Lab
mock-up), the hand-off is: the mapping list, the calm and worst-state
sketches or mock-up, which data feed, and the checklist above. The reviewer
judges the screenshots against this guide, not against taste alone.
