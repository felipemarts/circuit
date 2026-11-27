<?php
/**
 * Accounts: username + password only, for humans and agents alike. A login
 * returns a bearer token (sent as `Authorization: Bearer cv_…`); the database
 * keeps only its SHA-256. No cookies — so code running in a page (or a
 * circuit's custom-component code in the simulation worker) can never act on
 * the user's behalf unless it is handed the token.
 */

const USERNAME_RE = '/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/';
const RESERVED_USERNAMES = ['admin', 'root', 'api', 'circuitsvibe', 'system', 'anonymous', 'me'];

function token_from_request(): ?string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($h === '' && function_exists('apache_request_headers')) {
        foreach (apache_request_headers() as $k => $v) if (strcasecmp($k, 'Authorization') === 0) $h = $v;
    }
    if (preg_match('/^Bearer\s+(\S+)$/i', $h, $m)) return $m[1];
    $x = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? '';
    return $x !== '' ? $x : null;
}

/** The authenticated user, or null. */
function current_user(PDO $pdo): ?array
{
    static $user = false;
    if ($user !== false) return $user;
    $token = token_from_request();
    if ($token === null) return $user = null;
    $q = $pdo->prepare('SELECT u.id, u.username, u.kind, u.created_at, t.id AS token_id, t.last_used_at FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?');
    $q->execute([hash('sha256', $token)]);
    $row = $q->fetch();
    if (!$row) fail(401, 'unauthorized', 'invalid or revoked token; log in again');
    if ($row['last_used_at'] === null || time() - (int) $row['last_used_at'] > 300) {
        $pdo->prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?')->execute([time(), $row['token_id']]);
    }
    return $user = $row;
}

function require_user(PDO $pdo): array
{
    $u = current_user($pdo);
    if ($u === null) fail(401, 'unauthorized', 'log in first (POST /api/auth/login) and send Authorization: Bearer <token>');
    return $u;
}

function public_user(array $u): array
{
    return ['username' => $u['username'], 'kind' => $u['kind']];
}

function issue_token(PDO $pdo, int $userId, ?string $label): string
{
    $token = 'cv_' . bin2hex(random_bytes(24));
    $pdo->prepare('INSERT INTO tokens (user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)')
        ->execute([$userId, hash('sha256', $token), $label, time()]);
    return $token;
}

function route_register(PDO $pdo, array $config): never
{
    $b = body($config);
    $username = str_field($b, 'username', 32, true);
    $password = $b['password'] ?? null;
    $kind = $b['kind'] ?? 'human';
    if (!preg_match(USERNAME_RE, $username)) fail(422, 'validation', 'username: 3–32 letters, digits, "-" or "_", starting with a letter or digit');
    if (in_array(strtolower($username), RESERVED_USERNAMES, true)) fail(422, 'validation', "username '$username' is reserved");
    if (!is_string($password) || strlen($password) < 8 || strlen($password) > 200) fail(422, 'validation', 'password: 8–200 characters');
    if ($kind !== 'human' && $kind !== 'agent') fail(422, 'validation', "kind must be 'human' or 'agent'");
    rate_limit($pdo, 'register:' . client_ip(), $config['limits']['register']);
    $q = $pdo->prepare('SELECT 1 FROM users WHERE username = ?');
    $q->execute([$username]);
    if ($q->fetchColumn()) fail(409, 'conflict', "username '$username' is taken");
    $pdo->prepare('INSERT INTO users (username, password_hash, kind, created_at) VALUES (?, ?, ?, ?)')
        ->execute([$username, password_hash($password, PASSWORD_DEFAULT), $kind, time()]);
    $id = (int) $pdo->lastInsertId();
    $token = issue_token($pdo, $id, str_field($b, 'label', 64));
    respond(201, ['token' => $token, 'user' => ['username' => $username, 'kind' => $kind]]);
}

function route_login(PDO $pdo, array $config): never
{
    $b = body($config);
    $username = str_field($b, 'username', 32, true);
    $password = $b['password'] ?? '';
    $key = 'login:' . client_ip() . ':' . strtolower($username);
    rate_limit($pdo, $key, $config['limits']['login_fail'], false);
    $q = $pdo->prepare('SELECT id, username, kind, password_hash FROM users WHERE username = ?');
    $q->execute([$username]);
    $u = $q->fetch();
    // Verify against a dummy hash when the user does not exist: same timing either way.
    static $dummy = null;
    $hash = $u['password_hash'] ?? ($dummy ??= password_hash(random_bytes(16), PASSWORD_DEFAULT));
    if (!is_string($password) || !password_verify($password, $hash) || !$u) {
        record_hit($pdo, $key);
        fail(401, 'bad_credentials', 'wrong username or password');
    }
    if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) {
        $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $u['id']]);
    }
    $token = issue_token($pdo, (int) $u['id'], str_field($b, 'label', 64));
    respond(200, ['token' => $token, 'user' => public_user($u)]);
}

function route_logout(PDO $pdo): never
{
    $u = require_user($pdo);
    $pdo->prepare('DELETE FROM tokens WHERE id = ?')->execute([$u['token_id']]);
    respond(200, ['ok' => true]);
}

function route_me(PDO $pdo): never
{
    $u = require_user($pdo);
    $c = $pdo->prepare('SELECT COUNT(*) FROM circuits WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)');
    $c->execute([$u['id'], time()]);
    $k = $pdo->prepare('SELECT COUNT(*) FROM components WHERE user_id = ?');
    $k->execute([$u['id']]);
    respond(200, [
        'user' => public_user($u) + ['createdAt' => iso((int) $u['created_at'])],
        'circuits' => (int) $c->fetchColumn(),
        'components' => (int) $k->fetchColumn(),
    ]);
}

function route_user(PDO $pdo, string $username): never
{
    $q = $pdo->prepare('SELECT id, username, kind, created_at FROM users WHERE username = ?');
    $q->execute([$username]);
    $u = $q->fetch();
    if (!$u) fail(404, 'not_found', "no user '$username'");
    $c = $pdo->prepare("SELECT COUNT(*), COALESCE(SUM(stars), 0) FROM circuits WHERE user_id = ? AND visibility = 'public'");
    $c->execute([$u['id']]);
    [$circuits, $stars] = $c->fetch(PDO::FETCH_NUM);
    $k = $pdo->prepare('SELECT COUNT(*), COALESCE(SUM(uses), 0) FROM components WHERE user_id = ?');
    $k->execute([$u['id']]);
    [$components, $uses] = $k->fetch(PDO::FETCH_NUM);
    respond(200, ['user' => public_user($u) + ['createdAt' => iso((int) $u['created_at'])], 'publicCircuits' => (int) $circuits, 'stars' => (int) $stars, 'components' => (int) $components, 'componentUses' => (int) $uses]);
}
