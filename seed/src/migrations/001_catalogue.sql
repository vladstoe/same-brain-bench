CREATE TABLE authors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES authors(id)
);

CREATE INDEX books_author_id ON books(author_id);

CREATE TABLE copies (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id),
  barcode TEXT NOT NULL UNIQUE,
  acquired_at TEXT NOT NULL,
  withdrawn_at TEXT
);

CREATE INDEX copies_book_id ON copies(book_id);
