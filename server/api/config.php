<?php
/**
 * CircuitsVibe API configuration. Every value can be overridden by an
 * environment variable or by a `config.local.php` next to this file (not in
 * git, not overwritten by the deploy) that returns an array of overrides.
 */

$env = static function (string $name, $default) {
    $v = getenv($name);
    return $v === false || $v === '' ? $default : $v;
};

$config = [
    // SQLite database directory. Keep it out of the web root when the host allows it;
    // the default is protected by data/.htaccess (Require all denied).
    'data_dir' => $env('CIRCUITSVIBE_DATA_DIR', __DIR__ . '/data'),
    // Public site origin used in share links; empty = derived from the request.
    'site_url' => $env('CIRCUITSVIBE_SITE_URL', ''),
    // Private circuits expire after this many seconds (24 h).
    'private_ttl' => (int) $env('CIRCUITSVIBE_PRIVATE_TTL', 86400),
    // Size limits (bytes).
    'max_body_bytes' => (int) $env('CIRCUITSVIBE_MAX_BODY', 8 * 1024 * 1024),
    'max_doc_bytes' => (int) $env('CIRCUITSVIBE_MAX_DOC', 6 * 1024 * 1024),
    'max_source_bytes' => (int) $env('CIRCUITSVIBE_MAX_SOURCE', 256 * 1024),
    // Abuse limits (per window).
    'limits' => [
        'register' => [10, 3600],        // accounts per IP per hour
        'login_fail' => [10, 900],       // failed logins per IP+username per 15 min
        'circuit' => [120, 3600],        // circuits created per user per hour
        'component' => [60, 3600],       // component versions per user per hour
        'star' => [300, 3600],           // star/unstar per user per hour
    ],
];

$local = __DIR__ . '/config.local.php';
if (is_file($local)) {
    $overrides = require $local;
    if (is_array($overrides)) $config = array_replace_recursive($config, $overrides);
}

return $config;
