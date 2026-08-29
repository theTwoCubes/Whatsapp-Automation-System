-- FAQs replace the embedded knowledge units. The bot is given whole FAQ packs
-- verbatim instead of a similarity search over fragments, so what it knows is
-- exactly what the client wrote and can be checked by reading the list.
--
-- A pack is just a topic. topic_id null means the base pack, which every
-- conversation gets regardless of which service the lead came in through.
create table if not exists faqs (
  id bigserial primary key,
  topic_id bigint references topics(id) on delete cascade,
  question text not null,
  answer text not null,
  -- Answers that must be quoted word for word rather than paraphrased, for
  -- prices, durations and anything else where an approximation is wrong.
  verbatim boolean not null default false,
  -- Pinned entries are never dropped when trimming to fit the context budget.
  pinned boolean not null default false,
  position int not null default 0,
  -- The file to send when this answer is given. Descriptions on the asset are
  -- what the bot reads, it never inspects the file itself.
  media_asset_id bigint references media_assets(id) on delete set null,
  active boolean not null default true,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_faqs_pack on faqs (topic_id, position) where active = true;

-- Every write snapshots the resulting state, so an edit that breaks something
-- can be traced to who made it and rolled back to any earlier wording.
create table if not exists faq_versions (
  id bigserial primary key,
  faq_id bigint not null references faqs(id) on delete cascade,
  question text not null,
  answer text not null,
  verbatim boolean not null default false,
  actor text,
  created_at timestamptz not null default now()
);

create index if not exists idx_faq_versions_faq on faq_versions (faq_id, id desc);

-- Carry over what is already in the knowledge base. Base scope becomes the
-- base pack, topic scope keeps its topic. The old table is left in place until
-- the reply path stops reading from it.
insert into faqs (topic_id, question, answer, active, source, position, created_at)
select k.topic_id, k.title, k.content, k.active, k.source,
       row_number() over (partition by k.topic_id order by k.id),
       k.created_at
from knowledge_base k
where not exists (select 1 from faqs);

insert into faq_versions (faq_id, question, answer, verbatim, actor)
select f.id, f.question, f.answer, f.verbatim, 'migration'
from faqs f
where not exists (select 1 from faq_versions v where v.faq_id = f.id);
