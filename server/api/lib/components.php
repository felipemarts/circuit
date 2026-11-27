<?php
/**
 * Component registry: custom parts (`defineComponent` TypeScript modules)
 * published as `<user>/<name>`, with immutable numbered versions identified by
 * the SHA-256 of their source. The ranking orders components by how many
 * distinct users put them in a shared circuit (`uses`), then downloads.
 *
 * The source is CODE. The server never runs it; clients do — the web viewer
 * in its simulation worker, the CLI only after an explicit install
 * (`circuitsvibe component add`, which writes the file for review).
 */

const COMPONENT_NAME_RE = '/^[a-z][a-z0-9-]{1,39}$/';
const TYPE_NAME_RE = '/^[A-Za-z][A-Za-z0-9_]{0,63}$/';

function component_out(array $r, array $config): array
{
    $ref = $r['username'] . '/' . $r['name'];
    return [
        'ref' => $ref,
        'owner' => ['username' => $r['username'], 'kind' => $r['kind']],
        'name' => $r['name'],
        'description' => $r['description'],
        'tags' => $r['tags'] === '' ? [] : explode(',', $r['tags']),
        'latest' => (int) $r['latest'],
        'typeName' => $r['type_name'],
        'pins' => json_decode($r['pins'], true),
        'uses' => (int) $r['uses'],
        'circuits' => (int) $r['circuits'],
        'downloads' => (int) $r['downloads'],
        'createdAt' => iso((int) $r['created_at']),
        'updatedAt' => iso((int) $r['updated_at']),
        'install' => "npx circuitsvibe component add $ref",
        'url' => site_url($config) . '/wall.html#component=' . rawurlencode($ref),
    ];
}

const COMPONENT_SELECT = 'SELECT c.*, u.username, u.kind, v.type_name, v.pins FROM components c JOIN users u ON u.id = c.user_id JOIN component_versions v ON v.component_id = c.id AND v.version = c.latest';

function find_component(PDO $pdo, string $owner, string $name): array
{
    $q = $pdo->prepare(COMPONENT_SELECT . ' WHERE u.username = ? AND c.name = ?');
    $q->execute([$owner, $name]);
    $r = $q->fetch();
    if (!$r) fail(404, 'not_found', "no component '$owner/$name'");
    return $r;
}

/** POST /components — publish a new version (identical source = the existing version). */
function route_publish_component(PDO $pdo, array $config): never
{
    $me = require_user($pdo);
    $b = body($config);
    $name = str_field($b, 'name', 40, true);
    if (!preg_match(COMPONENT_NAME_RE, $name)) fail(422, 'validation', "name: 2–40 lowercase letters, digits or '-', starting with a letter (e.g. 'ntc-thermistor')");
    $source = $b['source'] ?? null;
    if (!is_string($source) || trim($source) === '') fail(422, 'validation', "'source' must be the component's TypeScript module text");
    if (strlen($source) > $config['max_source_bytes']) fail(413, 'too_large', "source is larger than {$config['max_source_bytes']} bytes");
    $typeName = str_field($b, 'typeName', 64, true);
    if (!preg_match(TYPE_NAME_RE, $typeName)) fail(422, 'validation', 'typeName: the ComponentDef name (letters, digits, _)');
    $pins = $b['pins'] ?? null;
    if (!is_array($pins) || !array_is_list($pins) || count($pins) < 1 || count($pins) > 128) fail(422, 'validation', "'pins' must be the list of pin names (1–128)");
    foreach ($pins as $p) if (!is_string($p) || $p === '' || strlen($p) > 32) fail(422, 'validation', 'every pin name must be a non-empty string (≤ 32 characters)');
    $params = $b['params'] ?? [];
    if (!is_array($params)) fail(422, 'validation', "'params' must be an object { name: { default, unit? } }");
    $description = str_field($b, 'description', 1000);
    $tags = tags_field($b);
    $hash = 'sha256:' . hash('sha256', $source);

    $now = time();
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $q = $pdo->prepare('SELECT id, latest FROM components WHERE user_id = ? AND name = ?');
        $q->execute([$me['id'], $name]);
        $c = $q->fetch();
        if ($c) {
            $same = $pdo->prepare('SELECT version FROM component_versions WHERE component_id = ? AND hash = ? ORDER BY version DESC LIMIT 1');
            $same->execute([$c['id'], $hash]);
            $existing = $same->fetchColumn();
        }
        if (!empty($existing)) {
            $version = (int) $existing;
            $created = false;
        } else {
            rate_limit($pdo, 'component:' . $me['id'], $config['limits']['component']);
            if (!$c) {
                $pdo->prepare('INSERT INTO components (user_id, name, description, tags, latest, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
                    ->execute([$me['id'], $name, $description ?? '', $tags ?? '', $now, $now]);
                $c = ['id' => (int) $pdo->lastInsertId(), 'latest' => 0];
            }
            $version = (int) $c['latest'] + 1;
            $pdo->prepare('INSERT INTO component_versions (component_id, version, type_name, pins, params, source, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute([$c['id'], $version, $typeName, json_encode(array_values($pins)), json_encode((object) $params), $source, $hash, $now]);
            $created = true;
        }
        $sets = ['latest = MAX(latest, ?)', 'updated_at = ?'];
        $args = [$version, $now];
        if ($description !== null) {
            $sets[] = 'description = ?';
            $args[] = $description;
        }
        if ($tags !== null) {
            $sets[] = 'tags = ?';
            $args[] = $tags;
        }
        $args[] = $c['id'];
        $pdo->prepare('UPDATE components SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
    $r = find_component($pdo, $me['username'], $name);
    respond($created ? 201 : 200, component_out($r, $config) + ['version' => $version, 'hash' => $hash, 'created' => $created]);
}

/** GET /components — the ranking (sort=uses|downloads|recent, q=search). */
function route_list_components(PDO $pdo, array $config): never
{
    [$limit, $offset, $page] = paging();
    $where = ['1 = 1'];
    $args = [];
    $q = trim((string) ($_GET['q'] ?? ''));
    foreach (array_slice(preg_split('/\s+/', $q, -1, PREG_SPLIT_NO_EMPTY), 0, 6) as $term) {
        $where[] = "(u.username || '/' || c.name || ' ' || c.description || ' ' || c.tags || ' ' || v.type_name) LIKE ? ESCAPE '\\'";
        $args[] = like_term(mb_substr($term, 0, 40));
    }
    if (isset($_GET['author']) && $_GET['author'] !== '') {
        $where[] = 'u.username = ?';
        $args[] = (string) $_GET['author'];
    }
    $order = match ($_GET['sort'] ?? 'uses') {
        'downloads' => 'c.downloads DESC, c.uses DESC, c.created_at ASC',
        'recent' => 'c.updated_at DESC',
        default => 'c.uses DESC, c.circuits DESC, c.downloads DESC, c.created_at ASC',
    };
    $sqlWhere = implode(' AND ', $where);
    $base = COMPONENT_SELECT . " WHERE $sqlWhere";
    $total = $pdo->prepare("SELECT COUNT(*) FROM ($base)");
    $total->execute($args);
    $list = $pdo->prepare("$base ORDER BY $order LIMIT $limit OFFSET $offset");
    $list->execute($args);
    $items = [];
    foreach ($list->fetchAll() as $i => $r) $items[] = ['rank' => $offset + $i + 1] + component_out($r, $config);
    respond(200, ['items' => $items, 'total' => (int) $total->fetchColumn(), 'page' => $page, 'limit' => $limit]);
}

/** GET /components/{owner}/{name} — details, version list and the latest source. */
function route_get_component(PDO $pdo, array $config, string $owner, string $name): never
{
    $r = find_component($pdo, $owner, $name);
    $v = $pdo->prepare('SELECT version, hash, type_name, pins, created_at FROM component_versions WHERE component_id = ? ORDER BY version DESC');
    $v->execute([$r['id']]);
    $versions = array_map(fn ($x) => ['version' => (int) $x['version'], 'hash' => $x['hash'], 'typeName' => $x['type_name'], 'pins' => json_decode($x['pins'], true), 'createdAt' => iso((int) $x['created_at'])], $v->fetchAll());
    respond(200, component_out($r, $config) + ['versions' => $versions, 'source' => version_row($pdo, (int) $r['id'], (int) $r['latest'])['source']]);
}

function version_row(PDO $pdo, int $componentId, int $version): array
{
    $q = $pdo->prepare('SELECT * FROM component_versions WHERE component_id = ? AND version = ?');
    $q->execute([$componentId, $version]);
    $row = $q->fetch();
    if (!$row) fail(404, 'not_found', "no version $version");
    return $row;
}

/** GET /components/{owner}/{name}/{version|latest} — the source of one version (counts a download). */
function route_get_component_version(PDO $pdo, array $config, string $owner, string $name, string $version): never
{
    $r = find_component($pdo, $owner, $name);
    $n = $version === 'latest' ? (int) $r['latest'] : (ctype_digit($version) ? (int) $version : 0);
    $row = version_row($pdo, (int) $r['id'], $n);
    $pdo->prepare('UPDATE components SET downloads = downloads + 1 WHERE id = ?')->execute([$r['id']]);
    respond(200, [
        'ref' => "{$r['username']}/{$r['name']}@{$row['version']}",
        'version' => (int) $row['version'],
        'hash' => $row['hash'],
        'typeName' => $row['type_name'],
        'pins' => json_decode($row['pins'], true),
        'params' => json_decode($row['params'], true),
        'source' => $row['source'],
        'createdAt' => iso((int) $row['created_at']),
    ]);
}
