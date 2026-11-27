<?php
/**
 * Circuits: a cache of circuit documents behind short links.
 *  - private: anyone with the link can open it until it expires (config private_ttl, 24 h);
 *  - public: listed on the wall (search, stars), never expires.
 * The document is stored as sent; the client validates it (the server checks the envelope).
 */

const CIRCUIT_SCHEMA = 'circuitsvibe-circuit/1';

function new_id(int $len = 10): string
{
    $alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    $out = '';
    while (strlen($out) < $len) {
        foreach (str_split(random_bytes($len * 2)) as $ch) {
            $b = ord($ch);
            if ($b >= 248) continue; // 248 = 4 · 62: no modulo bias
            $out .= $alphabet[$b % 62];
            if (strlen($out) === $len) break;
        }
    }
    return $out;
}

/** Check the envelope of a circuit document; returns [json, meta]. */
function check_doc(array $config, $doc): array
{
    if (!is_array($doc) || array_is_list($doc)) fail(422, 'validation', "'doc' must be a circuit document object");
    if (($doc['schema'] ?? null) !== CIRCUIT_SCHEMA) fail(422, 'validation', "'doc.schema' must be '" . CIRCUIT_SCHEMA . "' (create it with `circuitsvibe export`)");
    if (!is_string($doc['name'] ?? null) || trim($doc['name']) === '') fail(422, 'validation', "'doc.name' must be a non-empty string");
    if (!is_array($doc['components'] ?? null) || !array_is_list($doc['components'])) fail(422, 'validation', "'doc.components' must be an array");
    $json = json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    if (strlen($json) > $config['max_doc_bytes']) fail(413, 'too_large', 'the circuit document is larger than ' . $config['max_doc_bytes'] . ' bytes');
    $types = [];
    foreach ($doc['components'] as $c) {
        if (is_array($c) && is_string($c['type'] ?? null)) $types[$c['type']] = true;
    }
    ksort($types);
    $refs = [];
    foreach (($doc['definitions'] ?? []) as $d) {
        $ref = is_array($d) ? ($d['registry']['ref'] ?? null) : null;
        if (is_string($ref) && preg_match('#^([A-Za-z0-9][A-Za-z0-9_-]{2,31})/([a-z][a-z0-9-]{1,39})@(\d+)$#', $ref, $m)) $refs[] = [$m[1], $m[2]];
    }
    return [$json, ['types' => implode(',', array_keys($types)), 'components' => count($doc['components']), 'refs' => $refs]];
}

/** Registry components a circuit uses: count each (component, user) once in the ranking. */
function record_component_uses(PDO $pdo, int $userId, array $refs): void
{
    $now = time();
    $find = $pdo->prepare('SELECT c.id FROM components c JOIN users u ON u.id = c.user_id WHERE u.username = ? AND c.name = ?');
    $up = $pdo->prepare('INSERT INTO component_uses (component_id, user_id, circuits, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(component_id, user_id) DO UPDATE SET circuits = circuits + 1');
    $sync = $pdo->prepare('UPDATE components SET uses = (SELECT COUNT(*) FROM component_uses WHERE component_id = ?), circuits = (SELECT COALESCE(SUM(circuits), 0) FROM component_uses WHERE component_id = ?) WHERE id = ?');
    $seen = [];
    foreach ($refs as [$owner, $name]) {
        $find->execute([$owner, $name]);
        $id = $find->fetchColumn();
        if ($id === false || isset($seen[$id])) continue;
        $seen[$id] = true;
        $up->execute([$id, $userId, $now]);
        $sync->execute([$id, $id, $id]);
    }
}

function circuit_out(array $row, array $config, ?array $me, bool $withDoc): array
{
    $out = [
        'id' => $row['id'],
        'url' => site_url($config) . '/app.html?c=' . $row['id'],
        'visibility' => $row['visibility'],
        'title' => $row['title'],
        'description' => $row['description'],
        'tags' => $row['tags'] === '' ? [] : explode(',', $row['tags']),
        'name' => $row['name'],
        'types' => $row['types'] === '' ? [] : explode(',', $row['types']),
        'components' => (int) $row['components'],
        'size' => (int) $row['size'],
        'author' => ['username' => $row['username'], 'kind' => $row['kind']],
        'stars' => (int) $row['stars'],
        'views' => (int) $row['views'],
        'createdAt' => iso((int) $row['created_at']),
        'updatedAt' => iso((int) $row['updated_at']),
        'expiresAt' => iso($row['expires_at'] === null ? null : (int) $row['expires_at']),
    ];
    if ($me !== null) {
        $out['mine'] = (int) $row['user_id'] === (int) $me['id'];
        if (array_key_exists('starred', $row)) $out['starred'] = (bool) $row['starred'];
    }
    if ($withDoc) $out['doc'] = json_decode($row['doc'], true);
    return $out;
}

const CIRCUIT_COLS = 'c.id, c.user_id, c.visibility, c.title, c.description, c.tags, c.name, c.types, c.components, c.size, c.stars, c.views, c.created_at, c.updated_at, c.expires_at, u.username, u.kind';

function load_circuit(PDO $pdo, string $id, ?array $me, bool $withDoc = true): array
{
    if (!preg_match('/^[A-Za-z0-9]{6,16}$/', $id)) fail(404, 'not_found', 'no such circuit');
    $starred = $me ? ', EXISTS (SELECT 1 FROM stars s WHERE s.circuit_id = c.id AND s.user_id = ' . (int) $me['id'] . ') AS starred' : '';
    $q = $pdo->prepare('SELECT ' . CIRCUIT_COLS . ($withDoc ? ', c.doc' : '') . $starred . ' FROM circuits c JOIN users u ON u.id = c.user_id WHERE c.id = ?');
    $q->execute([$id]);
    $row = $q->fetch();
    if (!$row || ($row['expires_at'] !== null && (int) $row['expires_at'] <= time())) {
        fail(404, 'not_found', 'no such circuit — private links expire after a while; ask the author for a new one');
    }
    return $row;
}

function route_create_circuit(PDO $pdo, array $config): never
{
    $me = require_user($pdo);
    $b = body($config);
    [$json, $meta] = check_doc($config, $b['doc'] ?? null);
    $visibility = $b['visibility'] ?? 'private';
    if ($visibility !== 'private' && $visibility !== 'public') fail(422, 'validation', "visibility must be 'private' or 'public'");
    $doc = $b['doc'];
    $title = str_field($b, 'title', 120) ?? (is_string($doc['meta']['title'] ?? null) ? mb_substr(trim($doc['meta']['title']), 0, 120) : $doc['name']);
    if ($title === '') $title = $doc['name'];
    $description = str_field($b, 'description', 2000) ?? (is_string($doc['meta']['description'] ?? null) ? mb_substr($doc['meta']['description'], 0, 2000) : '');
    $tags = tags_field($b) ?? '';
    rate_limit($pdo, 'circuit:' . $me['id'], $config['limits']['circuit']);
    $now = time();
    $expires = $visibility === 'private' ? $now + $config['private_ttl'] : null;
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        do {
            $id = new_id();
            $exists = $pdo->prepare('SELECT 1 FROM circuits WHERE id = ?');
            $exists->execute([$id]);
        } while ($exists->fetchColumn());
        $pdo->prepare('INSERT INTO circuits (id, user_id, visibility, title, description, tags, name, types, components, doc, size, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$id, $me['id'], $visibility, $title, $description, $tags, mb_substr($doc['name'], 0, 120), $meta['types'], $meta['components'], $json, strlen($json), $now, $now, $expires]);
        record_component_uses($pdo, (int) $me['id'], $meta['refs']);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
    respond(201, circuit_out(load_circuit($pdo, $id, $me, false), $config, $me, false));
}

function route_get_circuit(PDO $pdo, array $config, string $id): never
{
    $me = current_user($pdo);
    $row = load_circuit($pdo, $id, $me);
    if (!$me || (int) $me['id'] !== (int) $row['user_id']) {
        $pdo->prepare('UPDATE circuits SET views = views + 1 WHERE id = ?')->execute([$id]);
        $row['views'] = (int) $row['views'] + 1;
    }
    respond(200, circuit_out($row, $config, $me, true));
}

function route_update_circuit(PDO $pdo, array $config, string $id): never
{
    $me = require_user($pdo);
    $row = load_circuit($pdo, $id, $me, false);
    if ((int) $row['user_id'] !== (int) $me['id']) fail(403, 'forbidden', 'only the author can change this circuit');
    $b = body($config);
    $sets = [];
    $args = [];
    if (array_key_exists('visibility', $b)) {
        if ($b['visibility'] !== 'private' && $b['visibility'] !== 'public') fail(422, 'validation', "visibility must be 'private' or 'public'");
        $sets[] = 'visibility = ?';
        $args[] = $b['visibility'];
        $sets[] = 'expires_at = ?';
        $args[] = $b['visibility'] === 'public' ? null : time() + $config['private_ttl'];
    }
    if (array_key_exists('title', $b)) {
        $t = str_field($b, 'title', 120, true);
        $sets[] = 'title = ?';
        $args[] = $t;
    }
    if (array_key_exists('description', $b)) {
        $sets[] = 'description = ?';
        $args[] = str_field($b, 'description', 2000) ?? '';
    }
    if (array_key_exists('tags', $b)) {
        $sets[] = 'tags = ?';
        $args[] = tags_field($b) ?? '';
    }
    if (array_key_exists('doc', $b)) {
        [$json, $meta] = check_doc($config, $b['doc']);
        array_push($sets, 'doc = ?', 'size = ?', 'types = ?', 'components = ?', 'name = ?');
        array_push($args, $json, strlen($json), $meta['types'], $meta['components'], mb_substr($b['doc']['name'], 0, 120));
        record_component_uses($pdo, (int) $me['id'], $meta['refs']);
    }
    if ($sets === []) fail(422, 'validation', 'nothing to change: send visibility, title, description, tags or doc');
    $sets[] = 'updated_at = ?';
    $args[] = time();
    $args[] = $id;
    $pdo->prepare('UPDATE circuits SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
    respond(200, circuit_out(load_circuit($pdo, $id, $me, false), $config, $me, false));
}

function route_delete_circuit(PDO $pdo, string $id): never
{
    $me = require_user($pdo);
    $row = load_circuit($pdo, $id, $me, false);
    if ((int) $row['user_id'] !== (int) $me['id']) fail(403, 'forbidden', 'only the author can delete this circuit');
    $pdo->prepare('DELETE FROM circuits WHERE id = ?')->execute([$id]);
    respond(200, ['ok' => true]);
}

function route_star(PDO $pdo, array $config, string $id, bool $on): never
{
    $me = require_user($pdo);
    $row = load_circuit($pdo, $id, $me, false);
    if ($row['visibility'] !== 'public') fail(409, 'conflict', 'only public circuits can be starred');
    rate_limit($pdo, 'star:' . $me['id'], $config['limits']['star']);
    if ($on) $pdo->prepare('INSERT OR IGNORE INTO stars (user_id, circuit_id, created_at) VALUES (?, ?, ?)')->execute([$me['id'], $id, time()]);
    else $pdo->prepare('DELETE FROM stars WHERE user_id = ? AND circuit_id = ?')->execute([$me['id'], $id]);
    $pdo->prepare('UPDATE circuits SET stars = (SELECT COUNT(*) FROM stars WHERE circuit_id = ?) WHERE id = ?')->execute([$id, $id]);
    respond(200, circuit_out(load_circuit($pdo, $id, $me, false), $config, $me, false));
}

/**
 * The wall: public circuits, searchable (q: words matched in title, description,
 * name, tags, component types and author), sorted by stars (default), recent or views.
 * `mine=1` lists the caller's own circuits (private ones included).
 */
function route_list_circuits(PDO $pdo, array $config): never
{
    $me = current_user($pdo);
    [$limit, $offset, $page] = paging();
    $where = [];
    $args = [];
    if (($_GET['mine'] ?? '') === '1') {
        if (!$me) fail(401, 'unauthorized', 'log in to list your circuits');
        $where[] = 'c.user_id = ?';
        $args[] = $me['id'];
        $where[] = '(c.expires_at IS NULL OR c.expires_at > ?)';
        $args[] = time();
    } else {
        $where[] = "c.visibility = 'public'";
    }
    if (isset($_GET['author']) && $_GET['author'] !== '') {
        $where[] = 'u.username = ?';
        $args[] = (string) $_GET['author'];
    }
    if (isset($_GET['tag']) && $_GET['tag'] !== '') {
        $where[] = "(',' || c.tags || ',') LIKE ? ESCAPE '\\'";
        $args[] = like_term(',' . strtolower((string) $_GET['tag']) . ',');
    }
    $q = trim((string) ($_GET['q'] ?? ''));
    foreach (array_slice(preg_split('/\s+/', $q, -1, PREG_SPLIT_NO_EMPTY), 0, 6) as $term) {
        $where[] = "(c.title || ' ' || c.description || ' ' || c.name || ' ' || c.tags || ' ' || c.types || ' ' || u.username) LIKE ? ESCAPE '\\'";
        $args[] = like_term(mb_substr($term, 0, 40));
    }
    $order = match ($_GET['sort'] ?? 'stars') {
        'recent' => 'c.created_at DESC',
        'views' => 'c.views DESC, c.created_at DESC',
        default => 'c.stars DESC, c.views DESC, c.created_at DESC',
    };
    $sqlWhere = implode(' AND ', $where);
    $total = $pdo->prepare("SELECT COUNT(*) FROM circuits c JOIN users u ON u.id = c.user_id WHERE $sqlWhere");
    $total->execute($args);
    $starred = $me ? ', EXISTS (SELECT 1 FROM stars s WHERE s.circuit_id = c.id AND s.user_id = ' . (int) $me['id'] . ') AS starred' : '';
    $list = $pdo->prepare('SELECT ' . CIRCUIT_COLS . $starred . " FROM circuits c JOIN users u ON u.id = c.user_id WHERE $sqlWhere ORDER BY $order LIMIT $limit OFFSET $offset");
    $list->execute($args);
    $items = array_map(fn ($r) => circuit_out($r, $config, $me, false), $list->fetchAll());
    respond(200, ['items' => $items, 'total' => (int) $total->fetchColumn(), 'page' => $page, 'limit' => $limit]);
}
