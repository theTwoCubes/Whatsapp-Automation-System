# Drip message templates

Three follow-up messages, sent on day 3, day 5, and day 8 after the first
contact if the lead has gone quiet. Any reply from the lead stops the sequence.

These are WhatsApp message templates. They must be submitted in WhatsApp Manager
(Meta Business Suite, WhatsApp Manager, Message Templates) and approved before
the drip cron can send them. Until then, Phase 5 stays blocked.

## Names

The template names below must match the values in `.env`:

- `DRIP_TEMPLATE_1` = `drip_day3`
- `DRIP_TEMPLATE_2` = `drip_day5`
- `DRIP_TEMPLATE_3` = `drip_day8`

If you name them differently in WhatsApp Manager, update `.env` to match.

## Category

Submit as Utility if the copy is genuinely helpful and not a sales push. Meta
often recategorises pushy copy to Marketing, which costs more. Write to be
useful and the category tends to stay Utility.

## Language

The drafts below are English. If you need Hindi or Hinglish, submit a version in
that language with the same template name and the right language code, and set
`DRIP_TEMPLATE_LANG` in `.env` to match.

## Draft copy

Every template ends with a quick-reply button. Tapping it reopens the 24-hour
window, which lets the AI answer for free again. Every template also gives a
clear way to opt out.

### drip_day3

Body:

```
Hi, just following up on your design enquiry with us. If you are still
thinking it over, I am happy to share a few sample designs so you can see the
quality. Reply STOP any time to stop these messages.
```

Quick-reply button: `Show me samples`

### drip_day5

Body:

```
Hi again. A lot of our clients had a few questions before starting, things
like timelines, revisions, or file formats. Happy to answer yours whenever
you are ready. Reply STOP to stop these messages.
```

Quick-reply button: `I have a question`

### drip_day8

Body:

```
Last note from me. If the timing is not right, no problem at all. Whenever you
want to move ahead with your design, just reply here and we will pick it up.
Reply STOP to stop these messages.
```

Quick-reply button: `I am interested`

## After approval

1. Confirm the approved names match `.env`.
2. Test with the accelerated clock (see docs/troubleshooting.md) before going live.
3. Watch the first real sends for `131049` frequency-cap responses. Those are
   normal and not an error. See the runbook in HANDOVER.md.
