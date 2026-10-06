-- ANSWER KEY, SECOND SLICE (S46): arXiv entries are a record kind.
--
-- Widens the one check that lists record kinds, and nothing else. An arXiv record is the paper's own
-- entry at a pinned version (locator `arxiv:1706.03762v7`), read from arXiv's API.
--
-- Apply AFTER 20261006160000_answer_key_graph.sql, which creates ak_records. The constraint name is
-- Postgres's default for that table's inline kind check (measured on a scratch Postgres 16).

alter table public.ak_records drop constraint ak_records_kind_check;
alter table public.ak_records
  add constraint ak_records_kind_check check (kind in ('npm', 'pypi', 'wikidata', 'claimreview', 'arxiv'));
