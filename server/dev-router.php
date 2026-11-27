<?php
// Local development / tests with PHP's built-in server:
//   php -S 127.0.0.1:8080 -t dist-site server/dev-router.php
// /api/* goes to the API front controller (server/api/index.php); everything else is static.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/api' || str_starts_with($path, '/api/')) {
    $_SERVER['SCRIPT_NAME'] = '/api/index.php';
    unset($_SERVER['PATH_INFO']);
    require __DIR__ . '/api/index.php';
    return true;
}
return false;
