CREATE TABLE migration_partial_marker (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL UNIQUE
);

INSERT INTO migration_partial_marker (id, value) VALUES (1, 'first');
INSERT INTO migration_partial_marker (id, value) VALUES (2, 'first');
