<?php
/** SQLite connection, schema migrations, rate limits and expiry purge. */

function db(array $config): PDO
{
    static $pdo = null;
    if ($pdo !== null) return $pdo;
    $dir = $config['data_dir'];
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        fail(500, 'storage', 'the data directory cannot be created');
    }
    $pdo = new PDO('sqlite:' . $dir . '/circuitsvibe.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA foreign_keys = ON');
    migrate($pdo);
    return $pdo;
}

const MIGRATIONS = [
    // 1: accounts, tokens, circuits, stars, components, rate limits
    <<<'SQL'
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'agent')),
        created_at INTEGER NOT NULL
    );
    CREATE TABLE tokens (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
    );
    CREATE TABLE circuits (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        types TEXT NOT NULL DEFAULT '',
        components INTEGER NOT NULL DEFAULT 0,
        doc TEXT NOT NULL,
        size INTEGER NOT NULL,
        stars INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
    );
    CREATE INDEX circuits_public ON circuits (visibility, stars DESC, created_at DESC);
    CREATE INDEX circuits_expiry ON circuits (expires_at) WHERE expires_at IS NOT NULL;
    CREATE INDEX circuits_owner ON circuits (user_id, created_at DESC);
    CREATE TABLE stars (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        circuit_id TEXT NOT NULL REFERENCES circuits(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, circuit_id)
    );
    CREATE TABLE components (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        latest INTEGER NOT NULL DEFAULT 0,
        uses INTEGER NOT NULL DEFAULT 0,
        circuits INTEGER NOT NULL DEFAULT 0,
        downloads INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (user_id, name)
    );
    CREATE TABLE component_versions (
        component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        type_name TEXT NOT NULL,
        pins TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (component_id, version)
    );
    -- usage: one row per (component, user) — the ranking counts distinct users, so
    -- re-sharing the same circuit many times does not inflate it.
    CREATE TABLE component_uses (
        component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        circuits INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (component_id, user_id)
    );
    CREATE TABLE hits (
        key TEXT NOT NULL,
        at INTEGER NOT NULL
    );
    CREATE INDEX hits_key ON hits (key, at);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    SQL,
];

function migrate(PDO $pdo): void
{
    $version = (int) $pdo->query('PRAGMA user_version')->fetchColumn();
    if ($version >= count(MIGRATIONS)) return;
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $version = (int) $pdo->query('PRAGMA user_version')->fetchColumn();
        for ($i = $version; $i < count(MIGRATIONS); $i++) {
            $pdo->exec(MIGRATIONS[$i]);
            $pdo->exec('PRAGMA user_version = ' . ($i + 1));
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

/** Count one hit on `key`; 429 when `limit` hits already happened within `window` seconds. */
function rate_limit(PDO $pdo, string $key, array $rule, bool $record = true): void
{
    [$limit, $window] = $rule;
    $now = time();
    $q = $pdo->prepare('SELECT COUNT(*) FROM hits WHERE key = ? AND at > ?');
    $q->execute([$key, $now - $window]);
    if ((int) $q->fetchColumn() >= $limit) {
        header('Retry-After: ' . $window);
        fail(429, 'rate_limited', 'too many requests; try again later');
    }
    if ($record) $pdo->prepare('INSERT INTO hits (key, at) VALUES (?, ?)')->execute([$key, $now]);
}

function record_hit(PDO $pdo, string $key): void
{
    $pdo->prepare('INSERT INTO hits (key, at) VALUES (?, ?)')->execute([$key, time()]);
}

/** Delete expired private circuits and old rate-limit rows (at most once a minute). */
function housekeeping(PDO $pdo): void
{
    $now = time();
    $last = (int) $pdo->query("SELECT value FROM meta WHERE key = 'housekeeping'")->fetchColumn();
    if ($now - $last < 60) return;
    $pdo->prepare("INSERT INTO meta (key, value) VALUES ('housekeeping', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")->execute([(string) $now]);
    $pdo->prepare('DELETE FROM circuits WHERE expires_at IS NOT NULL AND expires_at <= ?')->execute([$now]);
    $pdo->prepare('DELETE FROM hits WHERE at < ?')->execute([$now - 86400]);
}
