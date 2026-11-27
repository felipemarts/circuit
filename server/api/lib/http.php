<?php
/** JSON request/response helpers. */

// Shared hosts sometimes lack mbstring: byte-based fallbacks keep the API working.
if (!function_exists('mb_strlen')) {
    function mb_strlen(string $s): int { return preg_match_all('/./su', $s); }
    function mb_substr(string $s, int $start, ?int $length = null): string
    {
        preg_match_all('/./su', $s, $m);
        return implode('', array_slice($m[0], $start, $length));
    }
}

final class ApiError extends Exception
{
    public int $status;
    public string $errorCode;
    public array $extra;

    public function __construct(int $status, string $code, string $message, array $extra = [])
    {
        parent::__construct($message);
        $this->status = $status;
        $this->errorCode = $code;
        $this->extra = $extra;
    }
}

function fail(int $status, string $code, string $message, array $extra = []): never
{
    throw new ApiError($status, $code, $message, $extra);
}

function respond(int $status, $body): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

function cors(): void
{
    // Bearer tokens, no cookies: any origin may call the API (a token is never sent implicitly).
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Authorization, Content-Type, X-Auth-Token');
    header('Access-Control-Max-Age: 86400');
}

/** The JSON body as an associative array ({} when empty). */
function body(array $config): array
{
    static $parsed = null;
    if ($parsed !== null) return $parsed;
    $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($len > $config['max_body_bytes']) fail(413, 'too_large', "request body is larger than {$config['max_body_bytes']} bytes");
    $raw = file_get_contents('php://input', false, null, 0, $config['max_body_bytes'] + 1);
    if ($raw === false || $raw === '') return $parsed = [];
    if (strlen($raw) > $config['max_body_bytes']) fail(413, 'too_large', "request body is larger than {$config['max_body_bytes']} bytes");
    $data = json_decode($raw, true, 512);
    if (!is_array($data) || array_is_list($data) && $data !== []) fail(400, 'bad_json', 'the request body must be a JSON object');
    return $parsed = $data;
}

function str_field(array $b, string $key, int $max, bool $required = false): ?string
{
    if (!array_key_exists($key, $b) || $b[$key] === null) {
        if ($required) fail(422, 'validation', "'$key' is required");
        return null;
    }
    if (!is_string($b[$key])) fail(422, 'validation', "'$key' must be a string");
    $v = trim($b[$key]);
    if ($required && $v === '') fail(422, 'validation', "'$key' must not be empty");
    if (mb_strlen($v) > $max) fail(422, 'validation', "'$key' is longer than $max characters");
    return $v;
}

/** Tags: an array (or comma-separated string) of short lowercase words, at most 8. */
function tags_field(array $b): ?string
{
    if (!array_key_exists('tags', $b) || $b['tags'] === null) return null;
    $tags = is_string($b['tags']) ? explode(',', $b['tags']) : $b['tags'];
    if (!is_array($tags)) fail(422, 'validation', "'tags' must be an array of strings");
    $out = [];
    foreach ($tags as $t) {
        if (!is_string($t)) fail(422, 'validation', "'tags' must be an array of strings");
        $t = strtolower(trim($t));
        if ($t === '') continue;
        if (!preg_match('/^[a-z0-9][a-z0-9+#.-]{0,23}$/', $t)) fail(422, 'validation', "tag '$t': use up to 24 letters, digits, '-', '.', '+', '#'");
        $out[$t] = true;
    }
    if (count($out) > 8) fail(422, 'validation', 'at most 8 tags');
    return implode(',', array_keys($out));
}

function client_ip(): string
{
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

function iso(?int $t): ?string
{
    return $t === null ? null : gmdate('Y-m-d\TH:i:s\Z', $t);
}

/** Public origin for links: config site_url, else the request's scheme + host. */
function site_url(array $config): string
{
    if ($config['site_url'] !== '') return rtrim($config['site_url'], '/');
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return ($https ? 'https' : 'http') . '://' . $host;
}

/** page / limit query parameters. */
function paging(): array
{
    $limit = max(1, min(50, (int) ($_GET['limit'] ?? 20)));
    $page = max(1, (int) ($_GET['page'] ?? 1));
    return [$limit, ($page - 1) * $limit, $page];
}

/** Escape a user term for LIKE … ESCAPE '\'. */
function like_term(string $t): string
{
    return '%' . strtr($t, ['\\' => '\\\\', '%' => '\\%', '_' => '\\_']) . '%';
}
