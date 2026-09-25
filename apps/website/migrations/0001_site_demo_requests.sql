-- Demo requests from the OCSO website (apps/website, POST /api/demo-request), in the D1 database `ocso-site`.
-- Apply: npx wrangler d1 execute ocso-site --remote --file migrations/0001_site_demo_requests.sql
-- (or the D1 REST API /query endpoint). Columns match the field names in content/forms.ts.

CREATE TABLE IF NOT EXISTS site_demo_requests (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'scheduled', 'engaged', 'closed', 'spam')),
  -- About you
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL,
  -- Your company
  company       TEXT NOT NULL,
  website       TEXT,
  industry      TEXT NOT NULL,
  regions       TEXT,
  -- Your customer success
  team_size     TEXT NOT NULL,
  customers     TEXT NOT NULL,
  conversations TEXT NOT NULL,
  channels      TEXT NOT NULL,
  tools         TEXT,
  goals         TEXT NOT NULL,
  -- Bookkeeping
  source_page   TEXT,
  ip_hash       TEXT,
  ack_sent_at   TEXT,
  slack_sent_at TEXT
);
CREATE INDEX IF NOT EXISTS site_demo_requests_created ON site_demo_requests (created_at);
CREATE INDEX IF NOT EXISTS site_demo_requests_email ON site_demo_requests (email);
