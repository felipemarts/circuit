<?php
/**
 * CircuitsVibe API — PHP 8.1+, PDO SQLite. Deployed with the static site at
 * /api (see server/README.md). Front controller: every request lands here
 * (api/.htaccess rewrites; without mod_rewrite use /api/index.php/<route>).
 *
 *   POST   /auth/register            { username, password, kind?: 'human'|'agent' } → { token, user }
 *   POST   /auth/login               { username, password, label? }                  → { token, user }
 *   POST   /auth/logout              (revokes the token used)
 *   GET    /auth/me
 *   GET    /users/{username}
 *   GET    /circuits                 ?q= &sort=stars|recent|views &tag= &author= &page= &limit= &mine=1
 *   POST   /circuits                 { doc, visibility?: 'private'|'public', title?, description?, tags? }
 *   GET    /circuits/{id}
 *   PATCH  /circuits/{id}            { visibility?, title?, description?, tags?, doc? }
 *   DELETE /circuits/{id}
 *   PUT    /circuits/{id}/star       DELETE /circuits/{id}/star
 *   GET    /components               ?q= &sort=uses|downloads|recent &author= &page= &limit=
 *   POST   /components               { name, source, typeName, pins, params?, description?, tags? }
 *   GET    /components/{user}/{name}
 *   GET    /components/{user}/{name}/{version|latest}
 *   GET    /health
 *
 * Errors: HTTP status + { "error": { "code", "message" } }.
 */

declare(strict_types=1);

require __DIR__ . '/lib/http.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/circuits.php';
require __DIR__ . '/lib/components.php';

const API_VERSION = '1';

$config = require __DIR__ . '/config.php';

/** The route below the API directory: '/circuits/abc'. */
function route_path(): string
{
    if (!empty($_SERVER['PATH_INFO'])) return '/' . trim($_SERVER['PATH_INFO'], '/');
    $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/api/index.php')), '/');
    if ($base !== '' && str_starts_with($uri, $base)) $uri = substr($uri, strlen($base));
    if (str_starts_with($uri, '/index.php')) $uri = substr($uri, strlen('/index.php'));
    return '/' . trim(rawurldecode($uri), '/');
}

cors();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

try {
    $path = route_path();
    if ($path === '/' || $path === '/health') respond(200, ['ok' => true, 'api' => API_VERSION, 'privateTtl' => $config['private_ttl']]);
    $pdo = db($config);
    housekeeping($pdo);
    $seg = explode('/', ltrim($path, '/'));
    $n = count($seg);
    $is = static fn (string $m, int $len, string $first) => $method === $m && $n === $len && $seg[0] === $first;

    if ($seg[0] === 'auth' && $n === 2) {
        match (true) {
            $method === 'POST' && $seg[1] === 'register' => route_register($pdo, $config),
            $method === 'POST' && $seg[1] === 'login' => route_login($pdo, $config),
            $method === 'POST' && $seg[1] === 'logout' => route_logout($pdo),
            $method === 'GET' && $seg[1] === 'me' => route_me($pdo),
            default => null,
        };
    }
    if ($is('GET', 2, 'users')) route_user($pdo, $seg[1]);
    if ($seg[0] === 'circuits') {
        if ($n === 1 && $method === 'GET') route_list_circuits($pdo, $config);
        if ($n === 1 && $method === 'POST') route_create_circuit($pdo, $config);
        if ($n === 2 && $method === 'GET') route_get_circuit($pdo, $config, $seg[1]);
        if ($n === 2 && $method === 'PATCH') route_update_circuit($pdo, $config, $seg[1]);
        if ($n === 2 && $method === 'DELETE') route_delete_circuit($pdo, $seg[1]);
        if ($n === 3 && $seg[2] === 'star' && ($method === 'PUT' || $method === 'POST')) route_star($pdo, $config, $seg[1], true);
        if ($n === 3 && $seg[2] === 'star' && $method === 'DELETE') route_star($pdo, $config, $seg[1], false);
    }
    if ($seg[0] === 'components') {
        if ($n === 1 && $method === 'GET') route_list_components($pdo, $config);
        if ($n === 1 && $method === 'POST') route_publish_component($pdo, $config);
        if ($n === 3 && $method === 'GET') route_get_component($pdo, $config, $seg[1], $seg[2]);
        if ($n === 4 && $method === 'GET') route_get_component_version($pdo, $config, $seg[1], $seg[2], $seg[3]);
    }
    fail(404, 'not_found', "no route $method $path");
} catch (ApiError $e) {
    respond($e->status, ['error' => ['code' => $e->errorCode, 'message' => $e->getMessage()] + $e->extra]);
} catch (Throwable $e) {
    error_log('circuitsvibe api: ' . $e);
    respond(500, ['error' => ['code' => 'internal', 'message' => 'internal error']]);
}
