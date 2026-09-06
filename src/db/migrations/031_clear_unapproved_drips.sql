-- Nothing has actually been approved by Meta yet. Clear the placeholder
-- drip template names so the scheduler never references a template that
-- does not exist. Configure real ones from the Follow-ups page once synced.
update topics set drip_steps = null;
update settings set value = '' where key = 'drip_steps';
