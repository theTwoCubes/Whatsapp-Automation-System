-- A lead who asks to stop receiving messages gets opted out at the contact
-- level (not just this conversation) - no more drip follow ups or bulk
-- sends to them, ever, until someone clears it by hand. Opting out does not
-- block them from messaging in and getting a normal reply; it only stops us
-- from reaching out to them unprompted.
alter table contacts add column if not exists opted_out_at timestamptz;
