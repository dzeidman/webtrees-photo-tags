<?php

declare(strict_types=1);

use Fisharebest\Webtrees\Auth;
use Fisharebest\Webtrees\DB;
use Fisharebest\Webtrees\Http\Exceptions\HttpAccessDeniedException;
use Fisharebest\Webtrees\I18N;
use Fisharebest\Webtrees\Individual;
use Fisharebest\Webtrees\Module\AbstractModule;
use Fisharebest\Webtrees\Module\ModuleCustomInterface;
use Fisharebest\Webtrees\Module\ModuleCustomTrait;
use Fisharebest\Webtrees\Module\ModuleGlobalInterface;
use Fisharebest\Webtrees\Module\ModuleGlobalTrait;
use Fisharebest\Webtrees\Module\ModuleTabInterface;
use Fisharebest\Webtrees\Module\ModuleTabTrait;
use Fisharebest\Webtrees\Registry;
use Fisharebest\Webtrees\Validator;
use Fisharebest\Webtrees\View;
use Illuminate\Database\Query\JoinClause;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

return new class extends AbstractModule implements
    ModuleCustomInterface,
    ModuleTabInterface,
    ModuleGlobalInterface
{
    use ModuleCustomTrait;
    use ModuleTabTrait;
    use ModuleGlobalTrait;

    public function title(): string
    {
        return I18N::translate('Photo tags');
    }

    public function description(): string
    {
        return I18N::translate('Tag individuals in photos.');
    }

    public function customModuleAuthorName(): string       { return ''; }
    public function customModuleVersion(): string          { return '1.0.0'; }
    public function customModuleSupportUrl(): string       { return ''; }
    public function customModuleLatestVersionUrl(): string { return ''; }

    public function resourcesFolder(): string
    {
        return __DIR__ . '/resources/';
    }

    public function boot(): void
    {
        View::registerNamespace($this->name(), $this->resourcesFolder() . 'views/');

        if (!DB::schema()->hasTable('photo_tags')) {
            DB::schema()->create('photo_tags', static function ($table): void {
                $table->increments('id');
                $table->integer('gedcom_id');
                $table->string('media_xref', 20);
                $table->string('fact_id', 32);
                $table->string('individual_xref', 20);
                $table->float('x');
                $table->float('y');
                $table->float('width');
                $table->float('height');
                $table->index(['gedcom_id', 'media_xref']);
                $table->index(['gedcom_id', 'individual_xref']);
            });
        }
    }

    // ── Individual page tab ────────────────────────────────────────────────

    public function defaultTabOrder(): int { return 50; }
    public function canLoadAjax(): bool    { return true; }

    public function hasTabContent(Individual $individual): bool { return true; }

    public function isGrayedOut(Individual $individual): bool
    {
        return DB::table('photo_tags')
            ->where('gedcom_id', '=', $individual->tree()->id())
            ->where('individual_xref', '=', $individual->xref())
            ->doesntExist();
    }

    public function getTabContent(Individual $individual): string
    {
        $tags = DB::table('photo_tags')
            ->where('gedcom_id', '=', $individual->tree()->id())
            ->where('individual_xref', '=', $individual->xref())
            ->get();

        $photos = [];
        foreach ($tags as $tag) {
            $media = Registry::mediaFactory()->make($tag->media_xref, $individual->tree());
            if ($media === null || !$media->canShow()) {
                continue;
            }
            foreach ($media->mediaFiles() as $media_file) {
                if ($media_file->factId() === $tag->fact_id && $media_file->isImage()) {
                    $photos[] = [
                        'tag'        => $tag,
                        'media'      => $media,
                        'media_file' => $media_file,
                    ];
                    break;
                }
            }
        }

        return view($this->name() . '::tab', [
            'individual' => $individual,
            'photos'     => $photos,
        ]);
    }

    // ── Global head/body injection ─────────────────────────────────────────

    public function headContent(): string
    {
        return '<link rel="stylesheet" href="' . e($this->assetUrl('css/photo-tags.css')) . '">';
    }

    public function bodyContent(): string
    {
        $request = Registry::container()->get(ServerRequestInterface::class);

        $can_edit  = false;
        $tree_name = '';

        try {
            $tree      = Validator::attributes($request)->tree();
            $user      = Validator::attributes($request)->user();
            $can_edit  = Auth::isEditor($tree, $user);
            $tree_name = $tree->name();
        } catch (\Exception) {
            // Not on a tree page; JS will do nothing.
        }

        $config = json_encode([
            'canEdit'    => $can_edit,
            'treeName'   => $tree_name,
            'moduleName' => $this->name(),
        ], JSON_THROW_ON_ERROR);

        return '<script>window.photoTagsConfig=' . $config . ';</script>'
            . '<script src="' . e($this->assetUrl('js/photo-tags.js')) . '"></script>';
    }

    // ── API: fetch tags for a media object ────────────────────────────────

    public function getTagsAction(ServerRequestInterface $request): ResponseInterface
    {
        $tree       = Validator::attributes($request)->tree();
        $media_xref = Validator::queryParams($request)->string('xref');

        // Build list of image fact_ids in file order so the JS can match them
        // to gallery <img> elements by position.
        $media = Registry::mediaFactory()->make($media_xref, $tree);
        $files = [];
        if ($media && $media->canShow()) {
            foreach ($media->mediaFiles() as $media_file) {
                if ($media_file->isImage()) {
                    $files[] = $media_file->factId();
                }
            }
        }

        $tags = DB::table('photo_tags')
            ->where('gedcom_id', '=', $tree->id())
            ->where('media_xref', '=', $media_xref)
            ->get()
            ->map(function (object $row) use ($tree): array {
                $individual = Registry::individualFactory()->make($row->individual_xref, $tree);
                $can_show   = $individual !== null && $individual->canShow();

                return [
                    'id'              => (int) $row->id,
                    'fact_id'         => $row->fact_id,
                    'individual_xref' => $row->individual_xref,
                    'individual_name' => $can_show ? strip_tags($individual->fullName()) : '?',
                    'individual_url'  => $can_show ? $individual->url() : '',
                    'x'               => (float) $row->x,
                    'y'               => (float) $row->y,
                    'width'           => (float) $row->width,
                    'height'          => (float) $row->height,
                ];
            })
            ->toArray();

        return response(['files' => $files, 'tags' => $tags]);
    }

    // ── API: search individuals by name ───────────────────────────────────

    public function getSearchIndividualsAction(ServerRequestInterface $request): ResponseInterface
    {
        $tree  = Validator::attributes($request)->tree();
        $query = Validator::queryParams($request)->string('query', '');

        if (mb_strlen($query) < 2) {
            return response([]);
        }

        $xrefs = DB::table('individuals')
            ->join('name', static function (JoinClause $join): void {
                $join->on('name.n_file', '=', 'individuals.i_file')
                     ->on('name.n_id', '=', 'individuals.i_id');
            })
            ->where('individuals.i_file', '=', $tree->id())
            ->where('name.n_full', 'like', '%' . addcslashes($query, '%_\\') . '%')
            ->orderBy('name.n_sort')
            ->limit(20)
            ->distinct()
            ->pluck('individuals.i_id');

        $results = $xrefs
            ->map(static function (string $xref) use ($tree): ?array {
                $individual = Registry::individualFactory()->make($xref, $tree);
                if ($individual === null || !$individual->canShow()) {
                    return null;
                }
                return [
                    'xref'     => $xref,
                    'name'     => strip_tags($individual->fullName()),
                    'lifespan' => $individual->lifespan(),
                ];
            })
            ->filter()
            ->values();

        return response($results->toArray());
    }

    // ── API: save a new tag ───────────────────────────────────────────────

    public function postSaveTagAction(ServerRequestInterface $request): ResponseInterface
    {
        $tree = Validator::attributes($request)->tree();
        $user = Validator::attributes($request)->user();

        if (!Auth::isEditor($tree, $user)) {
            throw new HttpAccessDeniedException();
        }

        $body = Validator::parsedBody($request);

        DB::table('photo_tags')->insert([
            'gedcom_id'       => $tree->id(),
            'media_xref'      => $body->string('media_xref'),
            'fact_id'         => $body->string('fact_id'),
            'individual_xref' => $body->string('individual_xref'),
            'x'               => $body->float('x'),
            'y'               => $body->float('y'),
            'width'           => $body->float('width'),
            'height'          => $body->float('height'),
        ]);

        return response('', 204);
    }

    // ── API: delete a tag ─────────────────────────────────────────────────

    public function postDeleteTagAction(ServerRequestInterface $request): ResponseInterface
    {
        $tree = Validator::attributes($request)->tree();
        $user = Validator::attributes($request)->user();

        if (!Auth::isEditor($tree, $user)) {
            throw new HttpAccessDeniedException();
        }

        $id = Validator::parsedBody($request)->integer('id');

        DB::table('photo_tags')
            ->where('gedcom_id', '=', $tree->id())
            ->where('id', '=', $id)
            ->delete();

        return response('', 204);
    }
};
