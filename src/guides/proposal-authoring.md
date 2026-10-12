# Writing a Tempo proposal

A Tempo proposal is a web page you write (narrative, pricing, an interactive demo,
anything) plus a list of **questions** and **assumptions** the client answers. Tempo
shows your page in a frame and draws the review panel beside it: the client
answers questions, confirms or corrects assumptions, and leaves comments, then
presses Submit. The team gets one email per Submit.

You write the page and the manifest. **Tempo owns the review UI.** Do not build it.

## 1. The folder

```
my-proposal/
  index.html            # entry point (required, exactly this name)
  tempo-proposal.json   # the questions and assumptions (required if there are any)
  assets/...            # images, scripts, styles (optional)
```

A single self-contained `.html` file also works; it is uploaded as `index.html`.

Limits: 200 files, 10 MB per file, 25 MB in total. File and folder names may use
letters, digits, `.`, `_`, `-` and spaces. Hidden files (`.something`) are skipped.

## 2. Rules for the page

- **Relative paths only:** `assets/hero.png`, never `/assets/hero.png`. Content is
  served under a signed path prefix, so a root-absolute URL breaks.
- **External hosts:** only Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`),
  `cdnjs.cloudflare.com`, `cdn.jsdelivr.net` and `unpkg.com`. Pin exact versions
  (`react@18.3.1`, not `react@18`). Anything else is blocked by the content policy.
  Prefer bundling assets into the folder.
- **No network calls out:** forms cannot submit (`form-action 'none'`) and `fetch`/XHR
  to other origins is blocked. Same-origin `fetch` of your own files (e.g. a JSON
  data file in the folder) is fine.
- **localStorage is fine.** Each proposal has its own origin.
- **Do not draw Questions, Assumptions, comment boxes, answer inputs or a Submit
  button.** The client's answers only reach the team through Tempo's panel. You may
  *mention* items in the narrative ("see Q4") and anchor them (below).
- **Print:** add `@media print` styles. For an interactive demo, print a static
  version (e.g. every screen stacked, each with its caption). Tempo's toolbar has a
  Print button that prints the frame.
- Works on a phone: the frame is the full width on small screens and the panel
  becomes a bottom sheet.

## 3. The manifest: `tempo-proposal.json`

```json
{
  "items": [
    { "key": "A1", "kind": "assumption", "group": "Scope",
      "text": "You will provide the brand assets (logo, colours, fonts).",
      "detail": "If not, we add a short brand pass to Phase 1." },
    { "key": "Q1", "kind": "question", "group": "Launch",
      "text": "Do you need the site in Japanese at launch?",
      "answer_type": "yesno", "default": "no" },
    { "key": "Q2", "kind": "question", "group": "Launch",
      "text": "Which payment providers must checkout support?",
      "answer_type": "multi", "options": ["Stripe", "PayPal", "Bank transfer"],
      "default": ["Stripe"] },
    { "key": "Q3", "kind": "question", "group": "Launch",
      "text": "Who signs off on copy before it goes live?",
      "answer_type": "text" }
  ]
}
```

Fields:

| field | required | notes |
| --- | --- | --- |
| `key` | yes | Starts with a letter; letters, digits, `_`, `-`; max 32. Unique. |
| `kind` | yes | `question` or `assumption`. |
| `text` | yes | The item itself, max 2000 chars. Write it so it stands alone in the panel. |
| `detail` | no | Context shown under the text (why you ask, what changes with the answer). |
| `group` | no | Section heading in the panel. Items keep the manifest's order. |
| `answer_type` | questions | `text` (default), `single`, `multi`, `yesno`. |
| `options` | single/multi | 1-50 strings. |
| `default` | no | Your recommended answer. The client can accept it in one click. `single`: one of the options. `multi`: an array of options. `yesno`: `"yes"` or `"no"`. |

Assumptions take no `answer_type`: the client confirms one or corrects it in their own
words. Every question also allows a free-text note, so `single` does not trap anyone.

Write good items:
- An assumption is a statement you are betting the plan on. If it is wrong, the price
  or timeline changes. Say what changes in `detail`.
- A question should be answerable in one sitting. Offer a `default` whenever you have
  a recommendation; it turns most of the review into "accept, accept, correct".
- Prefer `single`/`yesno` with a default over open `text` when the space of answers is
  small.

### Keys are permanent

Keys are how answers survive from one version to the next.
- **Never renumber.** If you drop Q3, Q4 stays Q4.
- **Never reuse a retired key** for a different question. Use a new key.
- Changing an item's `text`, `detail`, `answer_type` or `options` marks the client's
  earlier answer "question changed, please re-check". Changing only the `default`
  does not. So fix typos freely, but know that rewording asks the client again.

## 4. Anchors: connecting the page to the panel

Anchors are plain HTML attributes. Tempo's frame script finds them.

**Item anchors.** Put `data-tempo-anchor="<item key>"` on the element that discusses
that item:

```html
<p data-tempo-anchor="A1">We'll build from your existing brand kit…</p>
<div class="callout" data-tempo-anchor="Q2">Checkout supports Stripe today…</div>
```

Tempo adds a small badge to the element showing its answer/comment count. Clicking the
badge opens that item in the panel; "Show in proposal" in the panel scrolls the page to
it and flashes it.

**Section anchors.** Let the client pin a comment to a part of the page that is not an
item. The key must start with `sec:` (or `screen:`, below); give it a label:

```html
<section data-tempo-anchor="sec:pricing" data-tempo-label="Pricing">…</section>
```

Anchor every major section. A comment pinned to "Pricing" is far more useful to the
team than a floating one.

**Interactive demos.** If the page shows one screen at a time, tell Tempo which screen
is showing whenever it changes. Comments the client writes while that screen is up are
pinned to it:

```js
function showScreen(id, label) {
  // …swap the visible screen…
  window.TempoBridge?.setContext(`screen:${id}`, label);
}
```

Also mark each screen's container with `data-tempo-anchor="screen:<id>"` and
`data-tempo-label`. When Tempo asks to show an anchor that sits on a hidden screen or
tab, switch to it first:

```js
window.TempoBridge?.on('highlight', (key) => {
  if (key.startsWith('screen:')) showScreen(key.slice(7));
  // or find the screen that contains [data-tempo-anchor="<key>"] and show it
});
```

The bridge then scrolls to the element and flashes it. Always use `?.`: the page must
still work when opened outside Tempo, where `window.TempoBridge` does not exist.

Notes:
- `window.TempoBridge` exists before your scripts run, so you can call it at load.
- Anchors added later by JavaScript are picked up, but the upload check only sees
  anchors written in the HTML, so it may say an item has no anchor when it does.
- An item with no anchor still appears in the panel. Anchors are for orientation.
- `data-tempo-anchor` with an item-shaped key (`Q9`) that is not in the manifest is
  flagged as a warning: usually a typo or a retired key.
- Pages built for claude.ai artifacts that call `window.claude.use("comments")` keep
  working: their comment buttons open Tempo's composer on the nearest anchor.

## 5. Uploading and the review loop

1. `tempo_create_proposal` once (attach it to a customer, a lead, or a prospect name).
   It starts with an empty draft v1.
2. `tempo_upload_proposal_version(proposal_id, path)` with the folder. It uploads the
   files, sets the items from `tempo-proposal.json`, and runs the checks. If the latest
   version is still a draft it is **replaced** in place; otherwise a new draft version
   is created.
3. **Read the result.** Fix every error and warning, then upload again (same draft).
   Info lines are advisory.
4. Tell the person to review the draft in the Tempo admin (the link in the result) and
   publish it. **You cannot publish.** Publishing shows it to the client and can email
   them; that is a person's decision.
5. After the client submits, `tempo_get_proposal_feedback(proposal_id)` returns their
   answers, corrections and comments. To write v2: keep the keys, fold the corrections
   into the narrative, settle answered questions in the text (and retire or reword
   those items), add new items with new keys, then upload. The new version is a new
   draft; publishing it supersedes the old one, and earlier answers carry over by key.

Answers that are drafts on the client's side are never visible to the team or to you.
Only what the client submitted is.
