# Photo Tags — webtrees custom module

Tag individuals in photos (Facebook-style bounding boxes). Installed by dropping this repo into `webtrees/modules_v4/photo-tags/` and enabling it at Admin → Modules → Tabs.

## Layout

```
module.php                       # Single-file module (anonymous class)
resources/
  css/photo-tags.css             # Overlay / draw layer / modal / tab grid styles
  js/photo-tags.js               # Runs on every page, activates on media pages
  views/tab.phtml                # Individual-page tab: thumbnail grid
```

## Module interfaces

`module.php` returns an anonymous class extending `AbstractModule` and implementing:

- `ModuleCustomInterface` — marks it as a third-party module
- `ModuleTabInterface` — adds the "Photo tags" tab on Individual pages
- `ModuleGlobalInterface` — injects CSS + JS on every page

## Database

`boot()` lazily creates the `photo_tags` table on first request:

| Column            | Type         | Notes                                         |
|-------------------|--------------|-----------------------------------------------|
| `id`              | int PK       |                                               |
| `gedcom_id`       | int          | `$tree->id()`                                 |
| `media_xref`      | string(20)   | Media record xref (e.g. `M123`)               |
| `fact_id`         | string(32)   | `MediaFile::factId()` — which file on the record |
| `individual_xref` | string(20)   | Tagged person                                 |
| `x`, `y`          | float        | Top-left corner, **fraction of image** (0–1)  |
| `width`, `height` | float        | Box size, **fraction of image** (0–1)         |

Storing coordinates as fractions means they scale correctly to any rendered size (full view, thumbnail, responsive).

Indexes: `(gedcom_id, media_xref)` and `(gedcom_id, individual_xref)`.

## HTTP endpoints

All routed under `/module/_photo-tags_/{Action}/{tree}`:

| Method | Action              | Purpose                                              |
|--------|---------------------|------------------------------------------------------|
| GET    | `Tags`              | Fetch tags + image fact_ids for a media xref         |
| GET    | `SearchIndividuals` | Name search (LIKE on `name.n_full`, limit 20)        |
| POST   | `SaveTag`           | Create a tag — editors only                          |
| POST   | `DeleteTag`         | Remove a tag by id — editors only                    |

`SaveTag`/`DeleteTag` throw `HttpAccessDeniedException` unless `Auth::isEditor($tree, $user)`. CSRF is handled by core middleware (`_csrf` field in the POST body).

## Media-page JS flow

`photo-tags.js` runs on every page but exits unless `window.location.pathname` matches `/tree/{name}/media/{xref}`.

1. `GET Tags?xref=…` returns `{ files: [factId, …], tags: [...] }`.
2. JS collects every `<a class="gallery"><img>` in DOM order and matches them to `files[index]` — **this is how multiple image files on one Media record stay aligned**. If webtrees ever changes the gallery markup or ordering, this breaks.
3. Each image is wrapped in `.pt-wrapper` (relative positioning). Tag boxes (`.pt-tag`) are absolutely positioned using `x * img.offsetWidth` etc.
4. Editors see a `+ Tag person` button beneath each image. Clicking it adds `.pt-draw-layer` on top; mouse-drag draws `.pt-draw-rect`; mouseup opens a modal, search picks the person, then POST `SaveTag`.
5. Tiny boxes (`< 2%` of width or height) are ignored to suppress accidental clicks.

## Individual-page tab

`getTabContent()` queries tags for the person, resolves each `(media_xref, fact_id)` to a `MediaFile`, and renders `tab.phtml`: a thumbnail grid (150×150) with the tagged region highlighted in yellow. Tab is grayed-out when the person has no tags. All lookups honour webtrees privacy via `canShow()`.

## Privacy

- Tag list results omit individuals failing `canShow()` (name becomes `?`, link is empty).
- Name search filters out private individuals after the LIKE query.
- The Individual-page tab skips media records and files that fail `canShow()`.

## webtrees gotchas

- **No Laravel helpers.** webtrees does not expose `app()`, `resolve()`, or similar globals. To get the current request from a non-request-handler method (e.g. `bodyContent()`), use:
  ```php
  $request = Registry::container()->get(ServerRequestInterface::class);
  ```
  Pattern matches core modules (`ChartsMenuModule`, `ModuleThemeTrait`, etc.). Using `app()` will fatal with "Call to undefined function app()".
- **Module endpoints are auto-routed** from public methods named `get{Name}Action` / `post{Name}Action`. The URL segment is `{Name}` (e.g. `getTagsAction` → `/Tags`).
- **`Validator::attributes($request)->tree()`** throws outside a tree context — wrap in try/catch when you can't guarantee the current page is under a tree (as `bodyContent()` does).
- **Views must be registered** in `boot()` via `View::registerNamespace($this->name(), …)` before `view('_photo-tags_::tab', …)` will resolve.

## Not implemented (future work)

- No tests. No migrations beyond the initial `boot()` table create — schema changes will need a manual `alter` path.
- No i18n `.mo` files; strings go through `I18N::translate()` but have no translations.
- `canEdit` check in JS is informational; server is the source of truth (editor check in `SaveTag`/`DeleteTag`).
- Touch/mobile draw mode not implemented — only `mousedown`/`mousemove`/`mouseup`.
