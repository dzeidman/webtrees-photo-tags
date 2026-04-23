'use strict';

(function () {
    const cfg = window.photoTagsConfig;
    if (!cfg || !cfg.treeName) return;

    const csrf       = document.querySelector('meta[name="csrf"]')?.content ?? '';
    const moduleName = cfg.moduleName;
    const treeName   = cfg.treeName;
    const canEdit    = cfg.canEdit;

    // True when this webtrees install uses legacy ?route=… URLs instead of rewritten pretty URLs.
    const legacyUrls = new URLSearchParams(window.location.search).has('route')
        || /\/index\.php$/.test(window.location.pathname);

    // Build a URL for a module action that requires a tree.
    function url(action, params) {
        const route = '/module/' + encodeURIComponent(moduleName) + '/' + action + '/' + encodeURIComponent(treeName);
        if (legacyUrls) {
            const qs = new URLSearchParams({ route, ...(params ?? {}) });
            return '/index.php?' + qs.toString();
        }
        let u = route;
        if (params) u += '?' + new URLSearchParams(params).toString();
        return u;
    }

    // ── Media-page detection ───────────────────────────────────────────────
    // Pretty URLs:  /tree/{name}/media/{xref}[/{slug}]
    // Legacy URLs: /index.php?route=/tree/{name}/media/{xref}[/{slug}]
    const routeParam = new URLSearchParams(window.location.search).get('route') ?? '';
    const haystack   = window.location.pathname + '|' + routeParam;
    const mediaMatch = haystack.match(/\/tree\/[^/]+\/media\/([^/?|]+)/);
    if (!mediaMatch) return;

    const mediaXref = decodeURIComponent(mediaMatch[1]);

    // Cache of tags fetched from the server.
    let tagsData = null;

    document.addEventListener('DOMContentLoaded', initMediaPage);

    // ── Initialise the media page ──────────────────────────────────────────

    async function initMediaPage() {
        tagsData = await fetchTags();

        // Each image is rendered as: <a class="gallery"><img ...></a>
        // Match them to fact_ids by position in the DOM.
        const links = Array.from(document.querySelectorAll('a.gallery')).filter(a => a.querySelector('img'));

        links.forEach((link, index) => {
            const factId = tagsData.files[index] ?? '';
            initImageWidget(link, factId);
        });
    }

    async function fetchTags() {
        try {
            const resp = await fetch(url('Tags', { xref: mediaXref }));
            return await resp.json();
        } catch (_) {
            return { files: [], tags: [] };
        }
    }

    // ── Per-image widget ───────────────────────────────────────────────────

    function initImageWidget(galleryLink, factId) {
        const img = galleryLink.querySelector('img');

        // Wrap the <a> in a relative-positioned container so we can overlay divs.
        const wrapper = document.createElement('div');
        wrapper.className = 'pt-wrapper';
        galleryLink.parentNode.insertBefore(wrapper, galleryLink);
        wrapper.appendChild(galleryLink);

        function setup() {
            renderTags(wrapper, img, factId);

            const row = document.createElement('div');
            row.className = 'pt-btn-row';
            wrapper.after(row);

            if (canEdit && factId) {
                const btn = makeTagButton();
                row.appendChild(btn);
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    startDrawMode(wrapper, img, factId, btn);
                });
            }

            if (factId) {
                const expandBtn = makeExpandButton();
                row.appendChild(expandBtn);
                expandBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    openExpandModal(wrapper, factId);
                });
            }
        }

        if (img.complete && img.naturalWidth > 0) {
            setup();
        } else {
            img.addEventListener('load', setup);
        }
    }

    // ── Render tag overlays ────────────────────────────────────────────────

    function renderTags(wrapper, img, factId) {
        wrapper.querySelectorAll('.pt-tag').forEach(el => el.remove());

        const w = img.offsetWidth;
        const h = img.offsetHeight;

        tagsData.tags
            .filter(t => t.fact_id === factId)
            .forEach(tag => {
                const el = document.createElement('div');
                el.className = 'pt-tag';
                el.style.left   = (tag.x * w) + 'px';
                el.style.top    = (tag.y * h) + 'px';
                el.style.width  = (tag.width * w) + 'px';
                el.style.height = (tag.height * h) + 'px';

                const label = document.createElement('div');
                label.className = 'pt-tag-label';
                if (tag.individual_url) {
                    const a = document.createElement('a');
                    a.href = tag.individual_url;
                    a.textContent = tag.individual_name;
                    label.appendChild(a);
                } else {
                    label.textContent = tag.individual_name;
                }
                el.appendChild(label);

                if (canEdit) {
                    const del = document.createElement('button');
                    del.className = 'pt-tag-delete';
                    del.title = 'Remove tag';
                    del.setAttribute('aria-label', 'Remove tag');
                    del.textContent = '×';
                    del.addEventListener('click', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!confirm('Remove this tag?')) return;
                        await deleteTag(tag.id);
                        tagsData.tags = tagsData.tags.filter(t => t.id !== tag.id);
                        renderTags(wrapper, img, factId);
                    });
                    el.appendChild(del);
                }

                wrapper.appendChild(el);
            });
    }

    // ── Draw-mode (editor only) ────────────────────────────────────────────

    function startDrawMode(wrapper, img, factId, btn) {
        btn.textContent = 'Cancel';
        btn.classList.add('active');

        const drawLayer = document.createElement('div');
        drawLayer.className = 'pt-draw-layer';
        wrapper.appendChild(drawLayer);

        let rect = null;
        let startX = 0;
        let startY = 0;

        function onDown(e) {
            e.preventDefault();
            const b = drawLayer.getBoundingClientRect();
            startX = e.clientX - b.left;
            startY = e.clientY - b.top;

            rect = document.createElement('div');
            rect.className = 'pt-draw-rect';
            drawLayer.appendChild(rect);

            drawLayer.addEventListener('mousemove', onMove);
            drawLayer.addEventListener('mouseup', onUp);
        }

        function onMove(e) {
            const b = drawLayer.getBoundingClientRect();
            const cx = e.clientX - b.left;
            const cy = e.clientY - b.top;
            rect.style.left   = Math.min(cx, startX) + 'px';
            rect.style.top    = Math.min(cy, startY) + 'px';
            rect.style.width  = Math.abs(cx - startX) + 'px';
            rect.style.height = Math.abs(cy - startY) + 'px';
        }

        async function onUp(e) {
            drawLayer.removeEventListener('mousemove', onMove);
            drawLayer.removeEventListener('mouseup', onUp);

            const b  = drawLayer.getBoundingClientRect();
            const cx = e.clientX - b.left;
            const cy = e.clientY - b.top;
            const rx = Math.min(startX, cx) / img.offsetWidth;
            const ry = Math.min(startY, cy) / img.offsetHeight;
            const rw = Math.abs(cx - startX) / img.offsetWidth;
            const rh = Math.abs(cy - startY) / img.offsetHeight;

            if (rect) { rect.remove(); rect = null; }

            // Ignore tiny accidental clicks.
            if (rw < 0.02 || rh < 0.02) return;

            const person = await showPersonSearch();
            if (person) {
                await saveTag(factId, person.xref, rx, ry, rw, rh);
                tagsData = await fetchTags();
                renderTags(wrapper, img, factId);
            }

            cancel();
        }

        drawLayer.addEventListener('mousedown', onDown);

        function cancel() {
            drawLayer.remove();
            btn.textContent = '+ Tag person';
            btn.classList.remove('active');
            btn.onclick = null;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                startDrawMode(wrapper, img, factId, btn);
            }, { once: true });
        }

        btn.addEventListener('click', cancel, { once: true });
    }

    // ── Person-search modal ────────────────────────────────────────────────

    function showPersonSearch() {
        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'pt-modal-backdrop';

            const dialog = document.createElement('div');
            dialog.className = 'pt-modal';
            dialog.innerHTML =
                '<h6 class="pt-modal-title">Tag a person</h6>' +
                '<input type="search" class="form-control form-control-sm" placeholder="Type a name…" autocomplete="off">' +
                '<ul class="pt-results list-group mt-2"></ul>' +
                '<button class="btn btn-sm btn-secondary mt-2 pt-cancel">Cancel</button>';

            document.body.appendChild(backdrop);
            document.body.appendChild(dialog);

            const input   = dialog.querySelector('input');
            const results = dialog.querySelector('.pt-results');
            let timer;

            input.focus();

            input.addEventListener('input', () => {
                clearTimeout(timer);
                const q = input.value.trim();
                if (q.length < 2) { results.innerHTML = ''; return; }
                timer = setTimeout(() => doSearch(q), 300);
            });

            async function doSearch(q) {
                results.innerHTML = '<li class="list-group-item text-muted small">Searching…</li>';
                try {
                    const resp = await fetch(url('SearchIndividuals', { query: q }));
                    const data = await resp.json();
                    results.innerHTML = '';
                    if (!data.length) {
                        results.innerHTML = '<li class="list-group-item text-muted small">No results</li>';
                        return;
                    }
                    data.forEach(person => {
                        const li = document.createElement('li');
                        li.className = 'list-group-item list-group-item-action pt-result-item';
                        li.textContent = person.name + (person.lifespan ? ' (' + person.lifespan + ')' : '');
                        li.addEventListener('click', () => close(person));
                        results.appendChild(li);
                    });
                } catch (_) {
                    results.innerHTML = '<li class="list-group-item text-danger small">Search failed</li>';
                }
            }

            function close(person) {
                backdrop.remove();
                dialog.remove();
                resolve(person ?? null);
            }

            dialog.querySelector('.pt-cancel').addEventListener('click', () => close(null));
            backdrop.addEventListener('click', () => close(null));
        });
    }

    // ── API helpers ────────────────────────────────────────────────────────

    function makeTagButton() {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-secondary pt-tag-btn mt-1';
        btn.textContent = '+ Tag person';
        return btn;
    }

    function makeExpandButton() {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-secondary pt-expand-btn mt-1';
        btn.textContent = '⛶ Expand';
        btn.title = 'Open larger view for tagging';
        return btn;
    }

    // ── Expand modal ───────────────────────────────────────────────────────

    function openExpandModal(thumbWrapper, factId) {
        const galleryLink = thumbWrapper.querySelector('a.gallery');
        const thumbImg    = thumbWrapper.querySelector('img');
        const largeSrc    = (galleryLink && galleryLink.href) || thumbImg.src;

        const backdrop = document.createElement('div');
        backdrop.className = 'pt-expand-backdrop';

        const container = document.createElement('div');
        container.className = 'pt-expand-container';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'pt-expand-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '×';

        const wrapper = document.createElement('div');
        wrapper.className = 'pt-wrapper pt-expand-wrapper';

        const img = document.createElement('img');
        img.className = 'pt-expand-img';
        img.alt = thumbImg.alt || '';

        wrapper.appendChild(img);
        container.appendChild(closeBtn);
        container.appendChild(wrapper);

        document.body.appendChild(backdrop);
        document.body.appendChild(container);

        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        function setup() {
            renderTags(wrapper, img, factId);

            if (canEdit && factId) {
                const btn = makeTagButton();
                btn.classList.add('pt-expand-tag-btn');
                container.appendChild(btn);
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    startDrawMode(wrapper, img, factId, btn);
                });
            }
        }

        img.addEventListener('load', setup);
        img.src = largeSrc;

        // Re-render overlays if the viewport resizes and the image reflows.
        function onResize() { renderTags(wrapper, img, factId); }
        window.addEventListener('resize', onResize);

        function close() {
            window.removeEventListener('resize', onResize);
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
            backdrop.remove();
            container.remove();
            // Refresh thumbnail overlays in case tags were added/removed.
            if (thumbImg) renderTags(thumbWrapper, thumbImg, factId);
        }
        function onKey(e) { if (e.key === 'Escape') close(); }

        document.addEventListener('keydown', onKey);
        closeBtn.addEventListener('click', close);
        backdrop.addEventListener('click', close);
    }

    async function saveTag(factId, individualXref, x, y, width, height) {
        await fetch(url('SaveTag'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                media_xref:       mediaXref,
                fact_id:          factId,
                individual_xref:  individualXref,
                x:                x,
                y:                y,
                width:            width,
                height:           height,
                _csrf:            csrf,
            }),
        });
    }

    async function deleteTag(id) {
        await fetch(url('DeleteTag'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ id, _csrf: csrf }),
        });
    }
})();
